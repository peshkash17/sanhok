-- Migration 007: Extract queue drain logic into a reusable function
-- This fixes the unreliable pg_cron '10 seconds' schedule on Supabase free tier

CREATE OR REPLACE FUNCTION drain_ingestion_queue(batch_size int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    rec RECORD;
    p jsonb;  -- Renamed from 'payload' to avoid ambiguity
    v_org_id uuid;
    v_group_id uuid;
    v_fingerprint text;
    v_processed int := 0;
    v_failed int := 0;
BEGIN
    FOR rec IN
        SELECT id, org_id, event_type, payload, idempotency_key
          FROM ingestion_queue
         WHERE attempts < 5
         ORDER BY enqueued_at
         LIMIT batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            p := rec.payload;  -- Use single-letter alias to avoid ambiguity
            v_org_id := rec.org_id;

            IF rec.event_type = 'error' THEN
                -- Upsert error group
                v_fingerprint := p->>'fingerprint';
                INSERT INTO error_groups (org_id, fingerprint, title, culprit, first_seen, last_seen, occurrence_count, user_count)
                VALUES (
                    v_org_id,
                    v_fingerprint,
                    p->>'title',
                    p->>'culprit',
                    (p->>'occurred_at')::timestamptz,
                    (p->>'occurred_at')::timestamptz,
                    1,
                    CASE WHEN p->>'user_id' IS NOT NULL THEN 1 ELSE 0 END
                )
                ON CONFLICT (org_id, fingerprint) DO UPDATE SET
                    occurrence_count = error_groups.occurrence_count + 1,
                    last_seen        = EXCLUDED.last_seen,
                    user_count       = error_groups.user_count + CASE
                        WHEN p->>'user_id' IS NOT NULL AND NOT EXISTS (
                            SELECT 1 FROM error_occurrences
                             WHERE group_id = error_groups.id
                               AND user_id = p->>'user_id'
                        ) THEN 1 ELSE 0 END,
                    status           = CASE
                        WHEN error_groups.status = 'resolved' THEN 'regressed'
                        ELSE error_groups.status
                    END,
                    regressed_at     = CASE
                        WHEN error_groups.status = 'resolved' THEN now()
                        ELSE error_groups.regressed_at
                    END
                RETURNING id INTO v_group_id;

                IF v_group_id IS NULL THEN
                    SELECT id INTO v_group_id FROM error_groups WHERE org_id = v_org_id AND fingerprint = v_fingerprint;
                END IF;

                -- Insert occurrence
                INSERT INTO error_occurrences (
                    org_id, group_id, message, exception_type, stack_trace,
                    user_id, user_email, tags, breadcrumbs, request_url, request_method,
                    occurred_at, sdk_version, environment, release
                ) VALUES (
                    v_org_id,
                    v_group_id,
                    p->>'message',
                    p->>'exception_type',
                    p->'stack_trace',
                    p->>'user_id',
                    p->>'user_email',
                    p->'tags',
                    p->'breadcrumbs',
                    p->>'request_url',
                    p->>'request_method',
                    COALESCE((p->>'occurred_at')::timestamptz, now()),
                    p->>'sdk_version',
                    COALESCE(p->>'environment', 'production'),
                    p->>'release'
                );

            ELSIF rec.event_type = 'activity' THEN
                -- Upsert session
                INSERT INTO sessions (org_id, session_id, anonymous_id, user_id, started_at, ended_at)
                VALUES (
                    v_org_id,
                    p->>'session_id',
                    p->>'anonymous_id',
                    p->>'user_id',
                    COALESCE((p->>'occurred_at')::timestamptz, now()),
                    COALESCE((p->>'occurred_at')::timestamptz, now()) + interval '30 minutes'
                )
                ON CONFLICT (org_id, session_id) DO UPDATE SET
                    ended_at         = GREATEST(sessions.ended_at, EXCLUDED.ended_at),
                    duration_seconds = EXTRACT(EPOCH FROM (GREATEST(sessions.ended_at, EXCLUDED.ended_at) - sessions.started_at))::int,
                    user_id          = COALESCE(sessions.user_id, EXCLUDED.user_id);

                -- Insert event
                INSERT INTO session_events (
                    org_id, session_id, event_type, event_name, properties, url, referrer, occurred_at
                ) VALUES (
                    v_org_id,
                    p->>'session_id',
                    p->>'event_type',
                    p->>'event_name',
                    p->'properties',
                    p->>'url',
                    p->>'referrer',
                    COALESCE((p->>'occurred_at')::timestamptz, now())
                );

                -- Handle identify
                IF p->>'event_type' = 'identify' AND p->>'user_id' IS NOT NULL THEN
                    INSERT INTO identity_map (org_id, anonymous_id, user_id, identified_at)
                    VALUES (v_org_id, p->>'anonymous_id', p->>'user_id', now())
                    ON CONFLICT (org_id, anonymous_id) DO UPDATE SET
                        user_id       = EXCLUDED.user_id,
                        identified_at = EXCLUDED.identified_at;

                    -- Retroactive stitching
                    UPDATE sessions
                       SET user_id = p->>'user_id'
                     WHERE org_id       = v_org_id
                       AND anonymous_id = p->>'anonymous_id'
                       AND user_id IS NULL;
                END IF;

            ELSIF rec.event_type = 'trace' THEN
                INSERT INTO traces (
                    org_id, trace_id, span_id, parent_span_id, operation,
                    duration_ms, status, started_at, ended_at, tags, resource_attributes
                ) VALUES (
                    v_org_id,
                    p->>'trace_id',
                    p->>'span_id',
                    p->>'parent_span_id',
                    p->>'operation',
                    (p->>'duration_ms')::numeric,
                    COALESCE(p->>'status', 'ok'),
                    COALESCE((p->>'started_at')::timestamptz, now()),
                    (p->>'ended_at')::timestamptz,
                    p->'tags',
                    p->'resource_attributes'
                );
            END IF;

            DELETE FROM ingestion_queue WHERE id = rec.id;
            v_processed := v_processed + 1;

        EXCEPTION WHEN OTHERS THEN
            UPDATE ingestion_queue
               SET attempts   = attempts + 1,
                   last_error = SQLERRM
             WHERE id = rec.id;
            v_failed := v_failed + 1;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'processed', v_processed,
        'failed', v_failed,
        'timestamp', now()
    );
END;
$$;

-- Update the cron job to call this function instead (more reliable at 1 minute intervals)
SELECT cron.unschedule('drain-ingestion-queue');

SELECT cron.schedule(
    'drain-ingestion-queue',
    '* * * * *',  -- Every minute (more reliable than 10 seconds)
    $$ SELECT drain_ingestion_queue(500); $$
);
