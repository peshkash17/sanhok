-- ============================================================
-- Migration 002: pg_cron scheduled jobs
-- ============================================================

-- Ensure pg_cron is enabled (run this in Supabase dashboard if needed)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- JOB 1: Queue Drainer — runs every 10 seconds
-- Drains ingestion_queue into typed tables
-- ============================================================
SELECT cron.schedule(
    'drain-ingestion-queue',
    '10 seconds',
    $cron$
    DO $$
    DECLARE
        rec RECORD;
        payload jsonb;
        v_org_id uuid;
        v_group_id uuid;
        v_fingerprint text;
        v_session_exists boolean;
    BEGIN
        FOR rec IN
            SELECT id, org_id, event_type, payload, idempotency_key
              FROM ingestion_queue
             WHERE attempts < 5
             ORDER BY enqueued_at
             LIMIT 500
            FOR UPDATE SKIP LOCKED
        LOOP
            BEGIN
                payload   := rec.payload;
                v_org_id  := rec.org_id;

                IF rec.event_type = 'error' THEN
                    -- Upsert error group
                    v_fingerprint := payload->>'fingerprint';
                    INSERT INTO error_groups (org_id, fingerprint, title, culprit, first_seen, last_seen, occurrence_count, user_count)
                    VALUES (
                        v_org_id,
                        v_fingerprint,
                        payload->>'title',
                        payload->>'culprit',
                        (payload->>'occurred_at')::timestamptz,
                        (payload->>'occurred_at')::timestamptz,
                        1,
                        CASE WHEN payload->>'user_id' IS NOT NULL THEN 1 ELSE 0 END
                    )
                    ON CONFLICT (org_id, fingerprint) DO UPDATE SET
                        occurrence_count = error_groups.occurrence_count + 1,
                        last_seen        = EXCLUDED.last_seen,
                        user_count       = error_groups.user_count + CASE
                            WHEN payload->>'user_id' IS NOT NULL AND NOT EXISTS (
                                SELECT 1 FROM error_occurrences
                                 WHERE group_id = error_groups.id
                                   AND user_id = payload->>'user_id'
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
                        payload->>'message',
                        payload->>'exception_type',
                        payload->'stack_trace',
                        payload->>'user_id',
                        payload->>'user_email',
                        payload->'tags',
                        payload->'breadcrumbs',
                        payload->>'request_url',
                        payload->>'request_method',
                        COALESCE((payload->>'occurred_at')::timestamptz, now()),
                        payload->>'sdk_version',
                        COALESCE(payload->>'environment', 'production'),
                        payload->>'release'
                    );

                ELSIF rec.event_type = 'activity' THEN
                    -- Upsert session
                    INSERT INTO sessions (org_id, session_id, anonymous_id, user_id, started_at, ended_at)
                    VALUES (
                        v_org_id,
                        payload->>'session_id',
                        payload->>'anonymous_id',
                        payload->>'user_id',
                        COALESCE((payload->>'occurred_at')::timestamptz, now()),
                        COALESCE((payload->>'occurred_at')::timestamptz, now()) + interval '30 minutes'
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
                        payload->>'session_id',
                        payload->>'event_type',
                        payload->>'event_name',
                        payload->'properties',
                        payload->>'url',
                        payload->>'referrer',
                        COALESCE((payload->>'occurred_at')::timestamptz, now())
                    );

                    -- Handle identify
                    IF payload->>'event_type' = 'identify' AND payload->>'user_id' IS NOT NULL THEN
                        INSERT INTO identity_map (org_id, anonymous_id, user_id, identified_at)
                        VALUES (v_org_id, payload->>'anonymous_id', payload->>'user_id', now())
                        ON CONFLICT (org_id, anonymous_id) DO UPDATE SET
                            user_id       = EXCLUDED.user_id,
                            identified_at = EXCLUDED.identified_at;

                        -- Retroactive stitching
                        UPDATE sessions
                           SET user_id = payload->>'user_id'
                         WHERE org_id       = v_org_id
                           AND anonymous_id = payload->>'anonymous_id'
                           AND user_id IS NULL;
                    END IF;

                ELSIF rec.event_type = 'trace' THEN
                    INSERT INTO traces (
                        org_id, trace_id, span_id, parent_span_id, operation,
                        duration_ms, status, started_at, ended_at, tags, resource_attributes
                    ) VALUES (
                        v_org_id,
                        payload->>'trace_id',
                        payload->>'span_id',
                        payload->>'parent_span_id',
                        payload->>'operation',
                        (payload->>'duration_ms')::numeric,
                        COALESCE(payload->>'status', 'ok'),
                        COALESCE((payload->>'started_at')::timestamptz, now()),
                        (payload->>'ended_at')::timestamptz,
                        payload->'tags',
                        payload->'resource_attributes'
                    );
                END IF;

                DELETE FROM ingestion_queue WHERE id = rec.id;

            EXCEPTION WHEN OTHERS THEN
                UPDATE ingestion_queue
                   SET attempts   = attempts + 1,
                       last_error = SQLERRM
                 WHERE id = rec.id;
            END;
        END LOOP;
    END;
    $$ LANGUAGE plpgsql;
    $cron$
);

-- ============================================================
-- JOB 2: Performance Aggregation — runs every 5 minutes
-- ============================================================
SELECT cron.schedule(
    'aggregate-performance',
    '*/5 * * * *',
    $$
    INSERT INTO perf_aggregates_hourly (org_id, operation, hour, p50, p90, p99, sample_count, total_ms)
    SELECT
        org_id,
        operation,
        date_trunc('hour', started_at) AS hour,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms),
        percentile_disc(0.90) WITHIN GROUP (ORDER BY duration_ms),
        percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms),
        count(*),
        sum(duration_ms)
      FROM traces
     WHERE started_at >= date_trunc('hour', now() - interval '1 hour')
       AND started_at <  date_trunc('hour', now())
     GROUP BY org_id, operation, date_trunc('hour', started_at)
    ON CONFLICT (org_id, operation, hour) DO UPDATE SET
        p50          = EXCLUDED.p50,
        p90          = EXCLUDED.p90,
        p99          = EXCLUDED.p99,
        sample_count = EXCLUDED.sample_count,
        total_ms     = EXCLUDED.total_ms;
    $$
);

-- ============================================================
-- JOB 3: Error Spike Detection — runs every 5 minutes
-- ============================================================
SELECT cron.schedule(
    'detect-error-spikes',
    '*/5 * * * *',
    $$
    WITH buckets AS (
        SELECT
            org_id,
            date_trunc('minute', occurred_at) - (EXTRACT(MINUTE FROM occurred_at)::int % 5) * interval '1 minute' AS bucket,
            count(*) AS cnt
          FROM error_occurrences
         WHERE occurred_at >= now() - interval '65 minutes'
         GROUP BY org_id, bucket
    ),
    stats AS (
        SELECT
            org_id,
            avg(cnt)        AS mean,
            stddev_pop(cnt) AS stddev,
            max(cnt) FILTER (WHERE bucket = date_trunc('minute', now() - interval '5 minutes') - (EXTRACT(MINUTE FROM (now() - interval '5 minutes'))::int % 5) * interval '1 minute') AS current_cnt
          FROM buckets
         WHERE bucket < date_trunc('minute', now()) - (EXTRACT(MINUTE FROM now())::int % 5) * interval '1 minute'
         GROUP BY org_id
    )
    INSERT INTO alerts (org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at)
    SELECT
        org_id,
        'error_spike',
        current_cnt,
        mean,
        ROUND(((current_cnt - mean) / NULLIF(mean, 0)) * 100, 2),
        5,
        now()
      FROM stats
     WHERE current_cnt > mean + (3 * stddev)
       AND current_cnt > 10
       AND stddev > 0
       AND mean IS NOT NULL
       AND current_cnt IS NOT NULL;
    $$
);

-- ============================================================
-- JOB 4: Latency Drift Detection — runs every 30 minutes
-- ============================================================
SELECT cron.schedule(
    'detect-latency-drift',
    '*/30 * * * *',
    $$
    WITH hourly_p90 AS (
        SELECT
            org_id,
            operation,
            hour,
            p90,
            extract(epoch FROM hour - min(hour) OVER (PARTITION BY org_id, operation)) / 3600.0 AS t
          FROM perf_aggregates_hourly
         WHERE hour >= now() - interval '24 hours'
    ),
    regression AS (
        SELECT
            org_id,
            operation,
            (count(*) * sum(t * p90) - sum(t) * sum(p90))
                / NULLIF(count(*) * sum(t * t) - sum(t) * sum(t), 0) AS slope_per_hour,
            avg(p90)    AS baseline_p90,
            max(p90)    AS current_p90,
            count(*)    AS sample_count
          FROM hourly_p90
         GROUP BY org_id, operation
    )
    INSERT INTO alerts (org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at, context)
    SELECT
        org_id,
        'latency_drift',
        current_p90,
        baseline_p90,
        ROUND(((current_p90 - baseline_p90) / NULLIF(baseline_p90, 0)) * 100, 2),
        1440,
        now(),
        jsonb_build_object('operation', operation, 'slope_ms_per_hour', ROUND(slope_per_hour::numeric, 3))
      FROM regression
     WHERE slope_per_hour > 5
       AND (current_p90 - baseline_p90) > baseline_p90 * 0.2
       AND sample_count >= 8;
    $$
);

-- ============================================================
-- JOB 5: Activity Drop Detection — runs every hour
-- ============================================================
SELECT cron.schedule(
    'detect-activity-drops',
    '0 * * * *',
    $$
    WITH current_hour AS (
        SELECT
            org_id,
            count(DISTINCT session_id) AS current_count
          FROM session_events
         WHERE occurred_at >= date_trunc('hour', now() - interval '1 hour')
           AND occurred_at <  date_trunc('hour', now())
         GROUP BY org_id
    ),
    historical AS (
        SELECT
            org_id,
            avg(hourly_count)        AS mean_count,
            stddev_pop(hourly_count) AS stddev_count
          FROM (
            SELECT
                org_id,
                date_trunc('hour', occurred_at) AS hr,
                count(DISTINCT session_id)       AS hourly_count
              FROM session_events
             WHERE extract(dow  FROM occurred_at) = extract(dow  FROM now() - interval '1 hour')
               AND extract(hour FROM occurred_at) = extract(hour FROM now() - interval '1 hour')
               AND occurred_at >= now() - interval '28 days'
               AND occurred_at <  now() - interval '7 days'
             GROUP BY org_id, hr
          ) hourly
         GROUP BY org_id
    )
    INSERT INTO alerts (org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at)
    SELECT
        c.org_id,
        'activity_drop',
        c.current_count,
        h.mean_count,
        ROUND(((c.current_count - h.mean_count) / NULLIF(h.mean_count, 0)) * 100, 2),
        60,
        now()
      FROM current_hour c
      JOIN historical h ON c.org_id = h.org_id
     WHERE c.current_count < h.mean_count - (2 * h.stddev_count)
       AND h.stddev_count > 0
       AND h.mean_count > 5;
    $$
);

-- ============================================================
-- JOB 6: Partition maintenance — runs on the 1st of each month
-- ============================================================
SELECT cron.schedule(
    'create-monthly-partitions',
    '0 0 1 * *',
    $cron$
    DO $$
    DECLARE
        next_month     date := date_trunc('month', now() + interval '2 months');
        month_after    date := date_trunc('month', now() + interval '3 months');
        partition_name text;
    BEGIN
        partition_name := 'error_occurrences_' || to_char(next_month, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF error_occurrences FOR VALUES FROM (%L) TO (%L)',
            partition_name, next_month, month_after
        );

        partition_name := 'traces_' || to_char(next_month, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF traces FOR VALUES FROM (%L) TO (%L)',
            partition_name, next_month, month_after
        );
    END;
    $$ LANGUAGE plpgsql;
    $cron$
);
