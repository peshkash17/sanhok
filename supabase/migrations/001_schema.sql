-- ============================================================
-- Migration 001: Full schema for the observability platform
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_net";

-- ============================================================
-- ORGANISATIONS & TENANCY
-- ============================================================

CREATE TABLE organisations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
    org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    email           text NOT NULL,
    role            text NOT NULL CHECK (role IN ('admin', 'member')),
    token_hash      text NOT NULL UNIQUE,
    expires_at      timestamptz NOT NULL,
    accepted_at     timestamptz,
    invited_by      uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- API keys: key is shown once, only the hash is stored
CREATE TABLE api_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    key_hash        text NOT NULL UNIQUE,  -- SHA-256 of the raw key
    prefix          varchar(16) NOT NULL,  -- first 12 chars for display (e.g. "sk_live_xxxx")
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz,
    revoked_at      timestamptz
);

CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- ============================================================
-- INGESTION INFRASTRUCTURE
-- ============================================================

CREATE TABLE ingestion_queue (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organisations(id),
    event_type          text NOT NULL CHECK (event_type IN ('error', 'activity', 'trace')),
    payload             jsonb NOT NULL,
    idempotency_key     text NOT NULL,
    enqueued_at         timestamptz NOT NULL DEFAULT now(),
    attempts            int NOT NULL DEFAULT 0,
    last_error          text,
    UNIQUE (org_id, idempotency_key)
);

CREATE INDEX idx_queue_enqueued ON ingestion_queue(enqueued_at) WHERE attempts < 5;

CREATE TABLE rate_limit_state (
    org_id          uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
    tokens          float8 NOT NULL DEFAULT 1000,
    last_refill     timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ERROR TRACKING
-- ============================================================

CREATE TABLE error_groups (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    fingerprint         text NOT NULL,
    title               text NOT NULL,         -- exception type + normalized message (first 200 chars)
    culprit             text,                  -- top non-vendor frame
    status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'regressed', 'ignored')),
    first_seen          timestamptz NOT NULL DEFAULT now(),
    last_seen           timestamptz NOT NULL DEFAULT now(),
    occurrence_count    bigint NOT NULL DEFAULT 1,
    user_count          bigint NOT NULL DEFAULT 0,
    resolved_at         timestamptz,
    resolved_by         uuid,
    regressed_at        timestamptz,
    UNIQUE (org_id, fingerprint)
);

CREATE INDEX idx_error_groups_org_status ON error_groups(org_id, status, last_seen DESC);
CREATE INDEX idx_error_groups_fingerprint ON error_groups(org_id, fingerprint);

-- Partitioned by occurred_at (monthly)
CREATE TABLE error_occurrences (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organisations(id),
    group_id        uuid NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
    message         text NOT NULL,
    exception_type  text,
    stack_trace     jsonb,          -- [{file, line, function, context_lines}]
    user_id         text,
    user_email      text,
    tags            jsonb,
    breadcrumbs     jsonb,
    request_url     text,
    request_method  text,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    sdk_version     text,
    environment     text DEFAULT 'production',
    release         text,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Create initial partitions (current month + 2 months ahead for safety)
CREATE TABLE error_occurrences_2026_02 PARTITION OF error_occurrences
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE error_occurrences_2026_03 PARTITION OF error_occurrences
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE error_occurrences_2026_04 PARTITION OF error_occurrences
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE error_occurrences_2026_05 PARTITION OF error_occurrences
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX idx_occurrences_group ON error_occurrences(org_id, group_id, occurred_at DESC);
CREATE INDEX idx_occurrences_org_time ON error_occurrences(org_id, occurred_at DESC);
CREATE INDEX idx_occurrences_user ON error_occurrences(org_id, user_id) WHERE user_id IS NOT NULL;

-- ============================================================
-- SESSION & ACTIVITY TRACKING
-- ============================================================

CREATE TABLE sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    session_id          text NOT NULL,          -- client-provided session identifier
    anonymous_id        text NOT NULL,
    user_id             text,
    started_at          timestamptz NOT NULL DEFAULT now(),
    ended_at            timestamptz,
    duration_seconds    int,
    UNIQUE (org_id, session_id)
);

CREATE INDEX idx_sessions_org_user ON sessions(org_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_sessions_org_anon ON sessions(org_id, anonymous_id);
CREATE INDEX idx_sessions_org_time ON sessions(org_id, started_at DESC);

CREATE TABLE session_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organisations(id),
    session_id      text NOT NULL,
    event_type      text NOT NULL,      -- 'page_view' | 'custom' | 'identify' | 'click' | etc.
    event_name      text NOT NULL,
    properties      jsonb,
    url             text,
    referrer        text,
    occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_events_session ON session_events(org_id, session_id, occurred_at);
CREATE INDEX idx_session_events_org_time ON session_events(org_id, occurred_at DESC);
CREATE INDEX idx_session_events_name ON session_events(org_id, event_name, occurred_at DESC);

CREATE TABLE identity_map (
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    anonymous_id    text NOT NULL,
    user_id         text NOT NULL,
    identified_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, anonymous_id)
);

CREATE INDEX idx_identity_map_user ON identity_map(org_id, user_id);

-- ============================================================
-- PERFORMANCE / TRACES
-- ============================================================

CREATE TABLE traces (
    id                      uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id                  uuid NOT NULL REFERENCES organisations(id),
    trace_id                text NOT NULL,
    span_id                 text NOT NULL,
    parent_span_id          text,
    operation               text NOT NULL,
    duration_ms             numeric NOT NULL,
    status                  text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'timeout')),
    started_at              timestamptz NOT NULL DEFAULT now(),
    ended_at                timestamptz,
    tags                    jsonb,
    resource_attributes     jsonb,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE traces_2026_02 PARTITION OF traces FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE traces_2026_03 PARTITION OF traces FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE traces_2026_04 PARTITION OF traces FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE traces_2026_05 PARTITION OF traces FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX idx_traces_org_operation ON traces(org_id, operation, started_at DESC);
CREATE INDEX idx_traces_org_time ON traces(org_id, started_at DESC);
CREATE INDEX idx_traces_trace_id ON traces(org_id, trace_id);

CREATE TABLE perf_aggregates_hourly (
    org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    operation       text NOT NULL,
    hour            timestamptz NOT NULL,       -- truncated to hour
    p50             numeric,
    p90             numeric,
    p99             numeric,
    sample_count    bigint NOT NULL DEFAULT 0,
    total_ms        numeric NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, operation, hour)
);

CREATE INDEX idx_perf_agg_org_op ON perf_aggregates_hourly(org_id, operation, hour DESC);

-- ============================================================
-- ALERTING
-- ============================================================

CREATE TABLE alerts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    type                text NOT NULL CHECK (type IN ('error_spike', 'latency_drift', 'activity_drop', 'error_regression')),
    metric_value        numeric NOT NULL,
    baseline_value      numeric NOT NULL,
    deviation_percent   numeric NOT NULL,
    duration_minutes    int NOT NULL,
    started_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    ai_explanation      text,
    context             jsonb
);

CREATE INDEX idx_alerts_org_time ON alerts(org_id, started_at DESC);
CREATE INDEX idx_alerts_org_active ON alerts(org_id, resolved_at) WHERE resolved_at IS NULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Enable RLS on all org-scoped tables
ALTER TABLE organisations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys              ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_occurrences     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_map          ENABLE ROW LEVEL SECURITY;
ALTER TABLE traces                ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_aggregates_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_queue       ENABLE ROW LEVEL SECURITY;

-- FORCE RLS even for table owners (prevents service-role bypass from app layer)
ALTER TABLE error_groups          FORCE ROW LEVEL SECURITY;
ALTER TABLE error_occurrences     FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions              FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_map          FORCE ROW LEVEL SECURITY;
ALTER TABLE traces                FORCE ROW LEVEL SECURITY;
ALTER TABLE perf_aggregates_hourly FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts                FORCE ROW LEVEL SECURITY;

-- The org isolation policy uses a session variable set by the API layer
-- current_setting('app.current_org_id', true) returns NULL if not set → no rows returned (safe default)
CREATE POLICY "org_isolation" ON error_groups
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON error_occurrences
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON sessions
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON session_events
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON identity_map
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON traces
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON perf_aggregates_hourly
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON alerts
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON api_keys
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON invitations
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON rate_limit_state
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

CREATE POLICY "org_isolation" ON ingestion_queue
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

-- org_members: members can see others in the same org
CREATE POLICY "org_members_isolation" ON org_members
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);

-- organisations: visible to members of that org
CREATE POLICY "org_self" ON organisations
    USING (id = (current_setting('app.current_org_id', true))::uuid);
