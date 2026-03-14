# Architecture Document: Self-Hosted Observability Platform

> **Status**: Living document. Written before implementation. Updated as decisions are validated or revised.

---

## Table of Contents

1. [Ingestion Under Load](#1-ingestion-under-load)
2. [Query Strategy](#2-query-strategy)
3. [Tenant Isolation](#3-tenant-isolation)
4. [One Rejected Decision Per Pillar](#4-one-rejected-decision-per-pillar)
5. [Error Tracking Design](#5-error-tracking-design)
6. [Session & Activity Tracking Design](#6-session--activity-tracking-design)
7. [Performance Monitoring Design](#7-performance-monitoring-design)
8. [Anomaly Detection & Alerting Design](#8-anomaly-detection--alerting-design)
9. [AI Integration Design](#9-ai-integration-design)
10. [Data Model Reference](#10-data-model-reference)

---

## 1. Ingestion Under Load

### What happens between an event arriving and it being queryable?

```
Client SDK
    │
    │  POST /api/ingest
    │  Authorization: Bearer sk_live_<key>
    │  Body: { idempotency_key, events: [...] }
    ▼
┌─────────────────────────────────────────────────────┐
│  Edge Middleware (Vercel)                           │
│  • Extract Bearer token                             │
│  • SHA-256 hash → lookup api_keys table             │
│  • Resolve org_id, check key not revoked            │
│  • Token-bucket rate limit check (rate_limit_state) │
│  • Reject: 401 / 429 / 400 before touching queue   │
└─────────────────────────────┬───────────────────────┘
                              │ authenticated + within rate limit
                              ▼
┌─────────────────────────────────────────────────────┐
│  Zod Validation                                     │
│  • Per-event-type schema enforcement                │
│  • Structured error response on any violation       │
│  • Reject malformed events before writing anything  │
└─────────────────────────────┬───────────────────────┘
                              │ valid batch
                              ▼
┌─────────────────────────────────────────────────────┐
│  ingestion_queue (Postgres table)                   │
│  INSERT … ON CONFLICT (org_id, idempotency_key)     │
│    DO NOTHING                                       │
│  • Idempotent: retried requests silently no-op      │
│  • Caller receives 200 as soon as row is written    │
│  • No fan-out, no synchronous processing            │
└─────────────────────────────┬───────────────────────┘
                              │
                 ┌────────────┘  pg_cron: every 10 seconds
                 ▼
┌─────────────────────────────────────────────────────┐
│  Queue Drainer (pg_cron job)                        │
│  • SELECT … FOR UPDATE SKIP LOCKED (batch of 500)  │
│  • Route by event_type:                             │
│      error    → error_occurrences + upsert          │
│                 error_groups (fingerprint)          │
│      activity → session_events + upsert sessions   │
│      trace    → traces                              │
│  • DELETE processed rows from ingestion_queue       │
│  • Increment attempts on failure; dead-letter at 5 │
└─────────────────────────────────────────────────────┘
                              │
            ~10 seconds after ingest call
                              ▼
                     Event is queryable
```

**Typical end-to-end latency**: < 5 ms to acknowledge (caller unblocked). ~10 s to queryable (next cron tick). Maximum observed lag before alert: queue depth × batch_time.

---

### What fails if any part is slow or down?

| Component | Failure Mode | Impact | Recovery |
|---|---|---|---|
| **Postgres (DB down)** | `ingestion_queue` INSERT fails → API returns 503 | **Events lost unless client retries.** Client SDK must buffer and retry with same `idempotency_key`. No duplicates on retry because of UNIQUE constraint. | Client retry; idempotency prevents double-counting |
| **pg_cron drainer slow** | Queue table grows; events not yet in typed tables | Events are accepted and acknowledged (200); dashboard shows stale data. Queryable lag increases. | Drainer auto-recovers when load drops. Queue depth is exposed as a metric; can trigger alerts. |
| **pg_cron drainer crashes** | Events sit in `ingestion_queue` with `attempts < 5` | No data loss (events are durably queued). Dashboard shows stale data until drainer restarts. | pg_cron retries automatically on next tick. Manual replay endpoint available for dead-lettered rows. |
| **Rate limiter table contention** | `rate_limit_state` row lock under high concurrency | Rate limit checks serialise; throughput drops. | Use `SELECT … FOR UPDATE SKIP LOCKED` or advisory locks; fall back to allowing requests if lock wait exceeds 50ms threshold. |
| **Validation layer bug** | Malformed events pass validation | Bad data in typed tables; fingerprinting may produce garbage | Zod schemas are unit-tested; typed tables have NOT NULL constraints as backstop |
| **Auth lookup slow** | `api_keys` table scan | Latency spike on every ingestion request | `api_keys.key_hash` has a unique index; lookup is O(log n). Connection pool warms this query. |

### What does not fail (by design)

- **Duplicate requests**: Identical `idempotency_key` returns 200 with zero DB side-effects. Safe to retry indefinitely.
- **Partial batches**: If a batch of 50 events has 3 malformed, the entire batch is rejected with a structured error listing which events and why. This is stricter than accepting partial batches, trading throughput for correctness.
- **Cross-tenant bleed**: Even if the drainer processes two orgs interleaved, `org_id` is written to every row and RLS enforces read isolation independently.

---

## 2. Query Strategy

### How do you keep aggregations fast as data grows?

#### Principle: Never aggregate at read time if you can aggregate at write time

The naive approach — running `SELECT COUNT(*), percentile_disc(0.99) …` over millions of raw rows on every dashboard load — fails at scale. The strategy is layered:

```
Raw event tables                 Materialised aggregates
─────────────────                ───────────────────────
error_occurrences                error_groups.occurrence_count  ← maintained on every insert (upsert in queue drainer)
traces                    →      perf_aggregates_hourly         ← pg_cron refresh every 5 min
```

#### Layer 1: Running counters in parent rows

`error_groups.occurrence_count` and `error_groups.user_count` are maintained as running totals. Every insert into `error_occurrences` does:
```sql
INSERT INTO error_occurrences …;
UPDATE error_groups
   SET occurrence_count = occurrence_count + 1,
       last_seen        = now(),
       user_count       = (SELECT COUNT(DISTINCT user_id) FROM error_occurrences WHERE group_id = $1)
 WHERE id = $1;
```
The `user_count` sub-select is bounded by the group size. For very active groups (> 100k occurrences) this sub-select is replaced by a HyperLogLog approximate count via the pg_hll extension.

#### Layer 2: Pre-aggregated time-series buckets

`perf_aggregates_hourly` is the source of truth for all performance charts. A pg_cron job upserts one row per `(org_id, operation, hour)` every 5 minutes using `percentile_disc` over raw traces within that hour:

```sql
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
```

Dashboard latency trend queries touch only `perf_aggregates_hourly` — a small table regardless of trace volume. The `sample_count` and `total_ms` columns are stored alongside percentiles so average latency can be computed cheaply at read time without touching raw traces.

#### Layer 3: Indexes tuned for access patterns

| Table | Index | Rationale |
|---|---|---|
| `error_occurrences` | B-tree `(org_id, group_id, occurred_at DESC)` | Paginate occurrences per group |
| `error_occurrences` | B-tree `(org_id, occurred_at DESC)` | Recent errors across org |
| `traces` | B-tree `(org_id, operation, started_at DESC)` | Slowest traces per operation |
| `traces` | B-tree `(org_id, started_at DESC)` | Time-range scans across all operations |
| `session_events` | B-tree `(org_id, session_id, occurred_at)` | Timeline reconstruction |
| `perf_aggregates_hourly` | B-tree `(org_id, operation, hour DESC)` | Trend queries |

#### Which Postgres features are load-bearing?

- **`percentile_disc` / `percentile_cont`**: Exact ordered-set aggregates used in the hourly refresh job. Accurate, not approximate. Bounded by the hourly bucket size, not total table size.
- **Declarative range partitioning** on `occurred_at` (monthly): each partition is a separate heap file. `error_occurrences_2026_03` is pruned automatically from queries targeting other months. Index scans stay in the current partition.
- **`SKIP LOCKED`** in the queue drainer: allows multiple drainer processes to run concurrently without blocking each other on the same queue rows.
- **`ON CONFLICT DO NOTHING / DO UPDATE`**: atomic upserts for idempotency and aggregate maintenance without application-level locking.
- **Partial indexes**: e.g. `WHERE attempts < 5` on `ingestion_queue` keeps the hot-path index small; `WHERE resolved_at IS NULL` on `alerts` covers the active-alert query with a minimal index.

#### What breaks first when volume doubles?

**First to break: `error_occurrences` full-group user_count sub-select.**

For a single error group with 500k occurrences, the `COUNT(DISTINCT user_id) FROM error_occurrences WHERE group_id = $1` sub-select scans the entire group partition. It's covered by the `(group_id, user_id)` index, but at 500k rows it takes ~200ms. Fix: switch to HyperLogLog approximate distinct counting (`pg_hll`), or maintain a separate `error_group_users(group_id, user_id)` join table with a unique constraint and count it with `count(*)`.

**Second to break: `percentile_disc` in the hourly refresh job for high-cardinality operations.**

The hourly job sorts all traces within a one-hour window per operation. If a single busy operation produces 1M traces/hour, sorting 1M rows every 5 minutes is expensive. Fix: pre-bucket into 5-minute windows; merge using t-digest approximate percentiles.

**Third to break: partition maintenance.**

Postgres declarative partitioning requires explicit creation of future partitions. A pg_cron job creates next month's partition on the 1st of each month. Failure to create the partition causes inserts to fail (`no partition of relation found`). Fix: create two future partitions (current month + 1, current month + 2) to give a safety buffer.

---

## 3. Tenant Isolation

### How is cross-org data access structurally prevented?

#### Every org-scoped table carries `org_id`

```sql
CREATE TABLE error_occurrences (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES organisations(id),
    group_id   uuid NOT NULL,
    -- ...
    occurred_at timestamptz NOT NULL
) PARTITION BY RANGE (occurred_at);
```

`org_id NOT NULL` is a schema-level enforcement: it is impossible to insert a row without an org. Foreign key to `organisations` ensures the org exists.

#### Row-Level Security enforced at the database layer

```sql
ALTER TABLE error_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_occurrences FORCE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON error_occurrences
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);
```

`FORCE ROW LEVEL SECURITY` means table owners (including the Supabase service role) are subject to RLS — there is no privileged bypass path from the application layer.

The session variable `app.current_org_id` is set at the start of every API request:

```sql
-- In a transaction, inside every API handler:
SET LOCAL app.current_org_id = '<uuid>';
-- All subsequent queries in this transaction are RLS-filtered automatically
```

`SET LOCAL` is scoped to the current transaction. It cannot bleed into the next request, even if the underlying Postgres connection is pooled and reused.

#### The flow: from API key to org_id, server-side only

```
Client request
    │
    │  Authorization: Bearer sk_live_<32 random bytes, base64>
    ▼
API middleware (server-side, never client-supplied)
    │
    │  1. Extract token from Authorization header
    │  2. SHA-256(token) → key_hash
    │  3. SELECT org_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL
    │  4. org_id is now known server-side
    │
    │  5. Begin transaction
    │  6. SET LOCAL app.current_org_id = '<org_id>'
    │  7. All DB queries in this request are now RLS-filtered to this org
    │  8. Commit / rollback
    ▼
Response
```

The `org_id` is **never** taken from the request body, query string, or any client-supplied header. It is always resolved server-side from the authenticated key. There is no code path where a client can specify which org they want to read.

For authenticated user sessions (dashboard), `org_id` is resolved from the `org_members` row matching `(supabase_auth.uid(), requested_org_slug)`, then set via the same `SET LOCAL` mechanism.

---

### One realistic bypass scenario and what stops it

**Scenario: Insecure Direct Object Reference in a dashboard API route**

A developer writes a new API route:
```typescript
// VULNERABLE — do not do this
export async function GET(req: Request, { params }: { params: { groupId: string } }) {
    const { data } = await supabase
        .from('error_occurrences')
        .select('*')
        .eq('group_id', params.groupId);  // ← groupId from URL, no org check
    return Response.json(data);
}
```

An attacker from Org B discovers a valid `group_id` UUID belonging to Org A (e.g., via timing, enumeration, or a separate information disclosure). They request:
```
GET /api/errors/3f7a2b1c-…/occurrences
```

**Why this fails (defence in depth)**:

1. **RLS is the last line, and it holds.** The Supabase client used in API routes sets `app.current_org_id` to the authenticated user's org (Org B). The RLS policy on `error_occurrences` evaluates `org_id = (current_setting('app.current_org_id'))::uuid`. The rows belonging to Org A have `org_id = <Org A UUID>`, which does not equal `<Org B UUID>`. The query returns zero rows. The attacker sees an empty array, not Org A's data.

2. **UUIDs are not guessable.** `gen_random_uuid()` produces cryptographically random 128-bit identifiers. There is no sequential enumeration path.

3. **Audit layer.** All queries that return zero rows when > 0 rows were expected (based on a known-valid `group_id`) are flagged in the application access log. This is anomaly signal for IDOR probing.

**What stops the bypass**: RLS at the DB layer is the structural guarantee. Even if the application code forgets to add `AND org_id = $currentOrg` to the query, the database enforces it. The application-layer check is defence-in-depth, not the primary guard.

**What RLS does *not* protect against**: A bug in the `SET LOCAL` logic itself — for example, if a request handler does not call `SET LOCAL` before querying. To mitigate: the DB user used by the API has RLS enabled with no default `app.current_org_id`, so a missing `SET LOCAL` means `current_setting('app.current_org_id', true)` returns `NULL`, and `NULL = any_uuid` is `NULL` (falsy), meaning **zero rows returned** rather than all rows. Failing open here returns empty, not all data.

---

## 4. One Rejected Decision Per Pillar

### 4.1 Ingestion: Rejected Kafka / Redpanda

**What was considered**: Kafka (or Redpanda, its drop-in replacement) as the ingestion buffer. Events would be published to a topic; a separate consumer service would drain topics and write to Postgres. This is the production architecture for systems like Datadog and Sentry at scale.

**Why rejected**:
- Requires a separately managed Kafka cluster (or Redpanda pod). Not available as a managed service on Supabase's platform, and adds significant operational surface area for a self-hosted tool.
- Complicates idempotency: Kafka at-least-once delivery still requires deduplication at the consumer. The queue-table approach collapses producer and deduplication into a single `ON CONFLICT DO NOTHING`.
- Adds a polyglot stack (JVM or Go consumer service) to a TypeScript-first codebase.
- At target scale (thousands of events/minute per org), Postgres with `SKIP LOCKED` queues handles the load comfortably without the operational overhead.

**Cost of the chosen approach (queue table + pg_cron)**:
- Maximum queryable lag is ~10 seconds (one cron tick). Not suitable for use cases requiring sub-second event visibility.
- The queue table is stored in the same Postgres instance as the application data. A DB overload event affects both ingestion and reads simultaneously, rather than isolating them.
- pg_cron has limited observability; drainer failures are logged to `cron.job_run_details` but do not surface alerts automatically. Requires explicit monitoring of queue depth.
- Throughput ceiling: Postgres can handle ~5k–10k `INSERT`s per second per instance. A single high-volume org can saturate the queue table. Mitigation: per-org rate limiting (implemented) and Postgres connection pooling via PgBouncer (Supabase provides this by default).

---

### 4.2 Query: Rejected ClickHouse

**What was considered**: ClickHouse as the analytics store. Error occurrences, traces, and session events would be written to ClickHouse (append-only, columnar); Postgres would keep only the mutable operational data (error_groups status, org metadata). ClickHouse's `quantileTDigest` and materialized views make percentile queries and time-series aggregations extremely fast at petabyte scale.

**Why rejected**:
- Requires a separately managed ClickHouse instance. Neither Supabase nor Vercel provide ClickHouse as a first-class service.
- Dual-write atomicity problem: writing to both Postgres (for `error_groups` upsert) and ClickHouse (for raw event storage) in a single logical operation requires a two-phase commit or saga pattern. Failures leave the two systems inconsistent.
- Adds a second query language (ClickHouse SQL dialect) and second connection pool to the application.
- Supabase RLS cannot be applied to ClickHouse tables; tenant isolation for the analytics store requires a separate implementation.
- The query volumes at target scale (< 100 orgs, < 10M events/month) are well within Postgres's capability with the pre-aggregation approach described in Pillar 2.

**Cost of the chosen approach (Postgres-only)**:
- Percentile accuracy tradeoff: `percentile_disc` in the hourly refresh job is exact within a bucket but cannot be merged across buckets. Querying "p99 over the last 7 days" sums hourly buckets — this is approximate (the actual p99 is not the average of 168 hourly p99s). The error is bounded and acceptable for operational dashboards; it's documented in the UI.
- Compression: Postgres TOAST compresses JSONB columns (stack traces) but cannot match ClickHouse's columnar compression ratios. Storage costs are ~5–10× higher per event.
- Scan speed: filtering across all `error_occurrences` rows for an org without an hourly pre-aggregate requires a sequential scan within the partition. This is bounded by partition size (1 month per org) but still slower than a ClickHouse columnar scan.

---

### 4.3 Tenant Isolation: Rejected Per-Schema Multi-Tenancy

**What was considered**: A separate Postgres schema (`org_<uuid>`) for each organisation, with identical table structure in each schema. Tenant isolation is physical — schemas have no shared heap pages. Migrations run `SET search_path = org_<uuid>` before applying DDL changes.

**Why rejected**:
- **Migration complexity**: every schema change requires N migration runs (one per tenant). At 100 orgs, `ALTER TABLE error_occurrences ADD COLUMN tags jsonb` must run 100 times. Each run is a separate transaction; if one fails mid-migration, schemas diverge.
- **Supabase incompatibility**: Supabase's auto-generated REST API (PostgREST), Realtime, and Auth integrations all assume a known schema. Dynamically provisioning and routing to per-org schemas bypasses the Supabase platform almost entirely.
- **Connection pool routing**: PgBouncer (used by Supabase) pools connections at the database level. Routing a connection to a specific schema requires `SET search_path` at session start, which is incompatible with transaction-mode pooling (each query may execute on a different connection).
- **Org creation latency**: spinning up a new schema (CREATE SCHEMA + ~20 CREATE TABLE + ~40 CREATE INDEX + ~20 CREATE POLICY) takes 2–5 seconds per org. RLS-based tenancy adds a new org in < 1 ms (just an INSERT into `organisations`).

**Cost of the chosen approach (shared schema + RLS)**:
- A missing or incorrect RLS policy on **any** org-scoped table exposes all tenants' data to any authenticated request. This is a single point of failure in the isolation model.
- Mitigation: every migration that creates an org-scoped table must include an RLS policy as part of the same migration transaction. A pre-commit hook and CI check (`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN (SELECT tablename FROM pg_policies WHERE policyname = 'org_isolation')`) enforces this.
- Index size: a single B-tree index on `(org_id, group_id, occurred_at)` must contain all orgs' data. At 100 orgs with 100M events each, the index is larger than a per-org index would be. But because `org_id` is always the leading column, index scans are still efficient (they scan only the subtree for the relevant org).

---

### 4.4 Anomaly Detection: Rejected User-Configured Thresholds

**What was considered**: A UI where engineers set alert rules: "alert if error rate > 50/min", "alert if p99 > 2000ms". Simple, explainable, and common in tools like Grafana and PagerDuty.

**Why rejected**:
- **Zero-configuration requirement**: the brief explicitly requires detection without user-configured thresholds. Threshold-based alerting requires users to know what their normal baseline is — the exact knowledge this tool is supposed to provide.
- **Brittle to growth**: a threshold of "100 errors/minute" is too sensitive on a busy day and too permissive on a quiet one. Dynamic baselines adapt automatically.
- **Misses gradual drift**: a p99 that grows from 200ms to 800ms over 12 hours never crosses a fixed threshold if it's set above 800ms. Statistical trend detection catches the slope, not the absolute value.

**Cost of the chosen approach (statistical detection)**:
- **Cold start problem**: statistical baselines require minimum sample sizes. Error spike detection requires 1+ hour of traffic to establish a 12-bucket baseline. Latency drift detection requires 8+ hours. Activity drop detection requires 4 weeks of history. During ramp-up, these detectors are silent — which is correct behaviour, but can feel like the system is broken.
- **False positives on unusual-but-valid events**: a planned marketing campaign that triples user traffic will trigger an "activity spike" detector. The system has no semantic understanding of calendar events, deployments, or intentional changes. Mitigation: alert suppression via a "maintenance window" API endpoint (not in MVP).
- **Computational cost**: linear regression over 24h of hourly data, running every 30 minutes for every (org, operation) pair, is O(orgs × operations × 48). At 50 orgs with 20 operations each, this is 48,000 regression computations every 30 minutes. Efficient in SQL but needs to be monitored.

---

## 5. Error Tracking Design

### Why exact message matching is insufficient

Raw error messages contain dynamic runtime values:

```
Error: User 'john@example.com' not found
Error: User 'alice@corp.com' not found
Error: User 'bob@startup.io' not found
```

These are three manifestations of the same bug. Exact message matching creates three separate "issues" despite having identical root causes, identical code paths, and needing one fix.

Other failure modes of exact matching:
- **Line numbers in stack frames**: deploy a new build → same bug, line numbers shift → new "issue" created. The issue history fragments across deployments.
- **Request IDs, trace IDs, timestamp strings**: commonly interpolated into error messages. Every occurrence becomes unique.
- **Database record IDs**: `"Record 8472 not found"` and `"Record 9831 not found"` are the same bug.
- **Locale-dependent messages**: same exception, different locale settings → different message strings.

### Fingerprinting Algorithm

```typescript
function fingerprint(event: ErrorEvent): string {
    // Step 1: Normalize the message — strip dynamic values
    const normalized = event.message
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b\d+\b/g, '<n>')
        .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '<email>')
        .replace(/https?:\/\/[^\s]+/g, '<url>')
        .replace(/'[^']*'/g, "'<str>'")
        .replace(/"[^"]*"/g, '"<str>"');

    // Step 2: Extract top 3 non-vendor frames
    const relevantFrames = event.stackTrace
        .filter(frame => !isVendorFrame(frame))  // exclude node_modules, runtime internals
        .slice(0, 3)
        .map(frame => `${frame.file}:${frame.function}`);  // path + function, NOT line number

    // Step 3: Hash the stable components
    const input = [event.exceptionType, normalized, ...relevantFrames].join('|');
    return sha256(input);
}
```

**Why top-3 frames only**: The deepest frame (where the throw happened) is the most stable identifier. Taking 3 provides enough specificity to distinguish similar errors in different contexts, without over-specifying (a change in the call chain 10 frames up should not create a new issue).

**Why file+function but not line number**: Function names survive refactors within a file better than line numbers survive any change to the file.

### Issue Lifecycle (Status FSM)

```
         new occurrence
              │
              ▼
           [open]
              │
              │ engineer marks resolved
              ▼
          [resolved] ──── new occurrence ──── [regressed]
              │                                    │
              │ engineer marks resolved             │ engineer marks resolved
              └────────────────────────────────────┘
```

**Regression detection**: when a new `error_occurrence` is inserted for a group with `status = 'resolved'`:
1. Set `error_groups.status = 'regressed'`
2. Set `error_groups.regressed_at = now()`
3. Create an alert of type `error_regression`
4. The previous `resolved_at` timestamp is preserved for audit trail

### What is stored per occurrence

```sql
error_occurrences:
  id            uuid PK
  org_id        uuid NOT NULL       -- for RLS
  group_id      uuid NOT NULL       -- FK to error_groups
  message       text NOT NULL       -- raw (unmodified) message
  exception_type text
  stack_trace   jsonb               -- [{file, line, function, context_lines}]
  user_id       text                -- nullable; who was affected
  user_email    text                -- nullable
  tags          jsonb               -- arbitrary SDK-provided key-value pairs
  breadcrumbs   jsonb               -- recent events leading up to the error
  request_url   text
  request_method text
  occurred_at   timestamptz NOT NULL
  sdk_version   text
  environment   text                -- 'production', 'staging', etc.
  release       text                -- git SHA or version tag
```

---

## 6. Session & Activity Tracking Design

### Session Definition and Reconstruction

A session begins when an `activity` event arrives with a `session_id` not seen in the last 30 minutes for that `anonymous_id`. A session ends when no events arrive for 30 minutes.

The 30-minute rule is a heuristic — it mirrors Google Analytics and is familiar, but has known failure modes (documented below). The session `ended_at` is set to `last_event_occurred_at + 30 minutes`; this is a projection, not a confirmed end time.

### Anonymous-to-Identified User Stitching

Two phases:

**Phase 1: Forward (real-time)**  
When an `identify()` event arrives with `{anonymous_id, user_id}`:
1. Upsert into `identity_map(org_id, anonymous_id, user_id, identified_at)`.
2. `UPDATE sessions SET user_id = $user_id WHERE org_id = $org_id AND anonymous_id = $anonymous_id AND user_id IS NULL`.
3. This retroactively attributes all prior sessions on this device to the identified user.

**Phase 2: Retroactive (inline)**  
Within the queue drainer, when an `identify` event is processed, an `UPDATE sessions SET user_id = $user_id WHERE org_id = $org_id AND anonymous_id = $anonymous_id AND user_id IS NULL` runs immediately after the `identity_map` upsert. This retroactively attributes all prior sessions on the same device to the identified user within the same drainer tick.

### Funnel Analysis

Path/funnel aggregation uses session-level sequence matching:

```sql
-- Count sessions that completed step 1 then step 2 (in that order, within the session)
SELECT
    COUNT(DISTINCT session_id) FILTER (WHERE has_step_1) AS step_1_count,
    COUNT(DISTINCT session_id) FILTER (WHERE has_step_1 AND has_step_2) AS step_2_count
FROM (
    SELECT
        session_id,
        bool_or(event_name = 'viewed_pricing') AS has_step_1,
        bool_or(event_name = 'clicked_signup' AND occurred_at > MIN(CASE WHEN event_name = 'viewed_pricing' THEN occurred_at END)) AS has_step_2
    FROM session_events
    WHERE org_id = $org_id
      AND occurred_at BETWEEN $from AND $to
    GROUP BY session_id
) sub;
```

Funnel steps are defined as event name sequences. No time-between-steps constraint is enforced in the MVP (a user who viewed pricing 3 weeks before signing up is still counted).

### Edge Cases This Approach Does Not Handle

1. **Shared device, multiple users**: A family computer where three people use the same browser. The last `identify()` call wins and retroactively attributes earlier sessions to the last-identified user. This is impossible to detect or correct without additional signals (e.g., fingerprinting, login events).

2. **Cross-device identity before identify()**: A user who browses on mobile (anonymous_id: `anon_abc`) and desktop (anonymous_id: `anon_def`) then identifies on desktop. Only the desktop sessions are retroactively attributed. The mobile sessions remain anonymous unless the user also identifies on mobile.

3. **Large-scale retroactive stitching**: An `identify()` call for an anonymous_id with 50,000 associated session rows triggers an `UPDATE` on 50,000 rows. This is an O(n) operation on the `sessions` table and will take several seconds. For high-volume use cases, the retroactive batch job should process these in chunks of 1,000 with `LIMIT` and `OFFSET`, or use a queueing mechanism. Not handled in MVP.

4. **Session boundary correctness**: A user who leaves a tab open without interacting for > 30 minutes, then continues, creates a new session even though it's a continuous experience. This overcounts sessions and undercounts session duration. Standard industry behaviour; documented, not fixed.

5. **Clock skew between SDKs**: If client-side events have timestamps from a client with a skewed clock, session reconstruction using `occurred_at` ordering will be incorrect. Mitigation: SDK sends both `client_timestamp` and `server_received_at`; timeline reconstruction uses `server_received_at` if clock skew > 5 minutes is detected.

---

## 7. Performance Monitoring Design

### Data Collection

Traces follow the OpenTelemetry span model: each span has a `trace_id` (groups all spans for one request), a `span_id` (unique to this span), and an optional `parent_span_id` (for nested spans). The ingestion API accepts spans individually or as a batch.

**For the MVP, all ingested spans** are included in latency distribution calculations. The `perf_aggregates_hourly` aggregation groups by `operation` name, so callers should use consistent, meaningful operation names (e.g. `db.query.getUser`, `http.GET /api/products`) to get useful per-operation metrics.

### Percentile Query Strategy

**Problem**: `percentile_disc(0.99) OVER ALL ROWS` for an org with 10M traces takes minutes.

**Solution**: Pre-aggregate into `perf_aggregates_hourly` using the pg_cron refresh described in Pillar 2.

**Accuracy tradeoff**: Dashboard shows "p99 over last 7 days" which is computed as the maximum of the 168 hourly p99 values (not a true cross-hour p99). This is a conservative overestimate — it's at least as high as the true p99, and for operational purposes (detecting whether something is slow), "the worst 1-hour p99 in the last 7 days" is a useful metric. The UI labels this accurately: "7-day peak p99 (hourly resolution)".

### Slowest Individual Traces

```sql
SELECT trace_id, operation, duration_ms, started_at, tags
  FROM traces
 WHERE org_id = $org_id
   AND operation = $operation
   AND started_at >= $from
 ORDER BY duration_ms DESC
 LIMIT 20;
```

Covered by the B-tree index on `(org_id, operation, started_at DESC)`. Postgres can use this index to satisfy the WHERE clause and avoid a full-table sort for the LIMIT.

### How Percentile Queries Stay Fast at Scale

1. **Hourly buckets are small**: even under high load, a one-hour window for a single operation has at most ~100k–200k traces. `percentile_disc` on 200k rows runs in ~200ms.
2. **Partition pruning**: `WHERE started_at >= date_trunc('hour', now() - interval '1 hour')` lets Postgres skip all partitions except the current month.
3. **Dashboard reads pre-aggregates, not raw traces**: the "latency trend" chart never touches the `traces` table directly.
4. **Sampling**: at very high volumes (> 1M traces/hour per org), head-based sampling (ingest 1% of traces) maintains statistical accuracy of percentile distributions while reducing storage. Not in MVP — documented as a scaling step.

---

## 8. Anomaly Detection & Alerting Design

### Why Three Algorithms for Three Structurally Different Problems

Error rate spikes, latency drift, and activity drops have different temporal signatures:

| Anomaly | Shape | Timescale | Detection approach |
|---|---|---|---|
| Error spike | Step function — sudden jump then plateau or recovery | Seconds to minutes | Threshold on deviation from rolling mean |
| Latency drift | Monotonic — slow, continuous increase | Hours to days | Linear regression slope on rolling window |
| Activity drop | Periodic — must compare to the same cycle | Daily/weekly | Seasonal comparison (same hour-of-week) |

A single algorithm (e.g., "alert if current value > N × average") handles the step function well but misses gradual drift (the average also rises) and mistakes seasonal lows for anomalies.

---

### 8.1 Error Rate Spike Detection

**Algorithm**: Control chart (±3σ) on 5-minute error count buckets.

```sql
-- Run every 5 minutes via pg_cron
-- Note: date_trunc does not accept interval strings; 5-min buckets use modulo arithmetic:
WITH buckets AS (
    SELECT
        org_id,
        date_trunc('minute', occurred_at)
            - (EXTRACT(MINUTE FROM occurred_at)::int % 5) * interval '1 minute' AS bucket,
        count(*) AS cnt
    FROM error_occurrences
    WHERE occurred_at >= now() - interval '65 minutes'
    GROUP BY org_id, bucket
),
stats AS (
    SELECT
        org_id,
        avg(cnt) AS mean,
        stddev_pop(cnt) AS stddev,
        max(cnt) FILTER (
            WHERE bucket = date_trunc('minute', now() - interval '5 minutes')
                - (EXTRACT(MINUTE FROM (now() - interval '5 minutes'))::int % 5)
                * interval '1 minute'
        ) AS current_cnt
    FROM buckets
    WHERE bucket < date_trunc('minute', now())
              - (EXTRACT(MINUTE FROM now())::int % 5) * interval '1 minute'
    GROUP BY org_id
)
INSERT INTO alerts (org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at)
SELECT
    org_id,
    'error_spike',
    current_cnt,
    mean,
    ((current_cnt - mean) / NULLIF(mean, 0)) * 100,
    5,
    now()
FROM stats
WHERE current_cnt > mean + (3 * stddev)
  AND current_cnt > 10              -- suppress 0→2 events triggering 3σ
  AND stddev > 0                    -- need meaningful variance
  AND mean IS NOT NULL
  AND current_cnt IS NOT NULL;
```

**Minimum data required**: 12 buckets = 60 minutes of traffic with at least some errors. During ramp-up, no alerts fire.

**Known weakness**: a sustained spike that lasts > 60 minutes will cause the rolling mean to adapt upward, eventually silencing the alert. This is the Anscombe-shift problem. Mitigation: track `alert.started_at` and sustain the alert rather than re-evaluating from scratch on each tick — an active alert is only resolved when the metric falls below `mean + 1σ` for two consecutive ticks.

---

### 8.2 Latency Drift Detection

**Algorithm**: Ordinary Least Squares linear regression slope on 24 hours of hourly p90 values.

```sql
-- Run every 30 minutes via pg_cron
WITH hourly_p90 AS (
    SELECT
        org_id,
        operation,
        hour,
        p90,
        extract(epoch FROM hour - min(hour) OVER (PARTITION BY org_id, operation)) / 3600 AS t
    FROM perf_aggregates_hourly
    WHERE hour >= now() - interval '24 hours'
),
regression AS (
    SELECT
        org_id,
        operation,
        -- OLS slope: (n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)
        (count(*) * sum(t * p90) - sum(t) * sum(p90))
            / NULLIF(count(*) * sum(t * t) - sum(t) * sum(t), 0) AS slope_per_hour,
        avg(p90) AS baseline_p90,
        count(*) AS sample_count,
        max(p90) AS current_p90
    FROM hourly_p90
    GROUP BY org_id, operation
)
INSERT INTO alerts (org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at, context)
SELECT
    org_id,
    'latency_drift',
    current_p90,
    baseline_p90,
    ((current_p90 - baseline_p90) / NULLIF(baseline_p90, 0)) * 100,
    1440,  -- 24 hours expressed in minutes
    now(),
    jsonb_build_object('operation', operation, 'slope_ms_per_hour', slope_per_hour)
FROM regression
WHERE slope_per_hour > 5                           -- rising at > 5ms/hour
  AND (current_p90 - baseline_p90) > baseline_p90 * 0.2  -- at least 20% cumulative drift
  AND sample_count >= 8                            -- minimum 8 hours of data
ON CONFLICT DO NOTHING;
```

**Minimum data required**: 8 hourly data points = 8 hours. If an operation has fewer points, no alert fires.

---

### 8.3 User Activity Drop Detection

**Algorithm**: Seasonal comparison — current hour-of-week vs. same hour-of-week over the prior 4 weeks.

```sql
-- Run every hour via pg_cron
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
        avg(hourly_count) AS mean_count,
        stddev_pop(hourly_count) AS stddev_count
    FROM (
        SELECT
            org_id,
            date_trunc('hour', occurred_at) AS hr,
            count(DISTINCT session_id) AS hourly_count
        FROM session_events
        WHERE extract(dow FROM occurred_at) = extract(dow FROM now() - interval '1 hour')
          AND extract(hour FROM occurred_at) = extract(hour FROM now() - interval '1 hour')
          AND occurred_at >= now() - interval '28 days'
          AND occurred_at < now() - interval '7 days'  -- exclude the past week (may be anomalous)
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
    ((c.current_count - h.mean_count) / NULLIF(h.mean_count, 0)) * 100,
    60,
    now()
FROM current_hour c
JOIN historical h ON c.org_id = h.org_id
WHERE c.current_count < h.mean_count - (2 * h.stddev_count)
  AND h.stddev_count > 0
  AND h.mean_count > 5  -- suppress alerts when baseline is near zero
ON CONFLICT DO NOTHING;
```

**Minimum data required**: 4 weeks of history for the same hour-of-week. Fewer than 4 data points → no alert fires.

---

### Alert Schema

```sql
CREATE TABLE alerts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES organisations(id),
    project_id        uuid,
    type              text NOT NULL,  -- 'error_spike' | 'latency_drift' | 'activity_drop' | 'error_regression'
    metric_value      numeric NOT NULL,   -- current observed value
    baseline_value    numeric NOT NULL,   -- computed baseline
    deviation_percent numeric NOT NULL,   -- signed; negative = drop, positive = spike
    duration_minutes  int NOT NULL,       -- how long the window is
    started_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,        -- NULL = still active
    ai_explanation    text,               -- NULL if AI unavailable; populated async
    context           jsonb               -- alert-type-specific extra data
);
```

---

## 9. AI Integration Design

### Anomaly Explanation

**Trigger**: After a row is inserted into `alerts`, a Supabase Database webhook (or pg_net HTTP call from pg_cron) fires an async request to a Next.js API route: `POST /api/ai/explain-alert`.

**Context assembled**:
```typescript
type ExplanationContext = {
    alert: Alert;                      // type, metric_value, baseline, deviation, duration
    topErrors: ErrorGroup[];           // top 5 error groups active in the same window
    affectedUserCount: number;         // distinct user_ids in error_occurrences during window
    recentDeployment?: string;         // last release tag seen in events (possible cause)
    deviationShape: 'spike' | 'gradual_rise' | 'sustained_drop';
    priorSimilarAlerts: Alert[];       // same type in last 7 days (is this recurring?)
};
```

**Prompt**:
```
You are an on-call engineer's assistant. A monitoring system has detected an anomaly.
Explain what happened and what to investigate first. Be specific. Do not include the word "significant".

Alert: {type} — {metric_value} vs baseline {baseline_value} ({deviation_percent}% deviation)
Duration: {duration_minutes} minutes
Top co-occurring errors: {topErrors}
Affected users: {affectedUserCount}
Most recent release: {recentDeployment}
Deviation shape: {deviationShape}
Similar alerts in last 7 days: {count}

Write 2-3 sentences maximum.
```

**Output**: Stored in `alerts.ai_explanation`. If the OpenAI call fails, returns null. The alert row always exists; the explanation is an optional annotation.

**What stops working without AI**:
- `alerts.ai_explanation` remains null
- The alert card in the UI shows the raw numbers (type, metric, baseline, deviation, duration) without the plain-language paragraph
- No automated triage suggestions
- All other platform features are unaffected

---

### Behaviour Summarisation

**Trigger**: On-demand via `GET /api/ai/behaviour-summary?orgId=X&from=Y&to=Z`.

**Data assembled server-side**:
```typescript
type BehaviourContext = {
    period: { from: Date; to: Date };
    priorPeriod: { from: Date; to: Date };
    topPages: { url: string; views: number; prior_views: number }[];
    topEvents: { name: string; count: number; prior_count: number }[];
    newUsers: number;
    returningUsers: number;
    medianSessionDuration: number;
    funnelCompletion: { step: string; rate: number; prior_rate: number }[];
    errorCount: number;
    priorErrorCount: number;
};
```

**Graceful degradation**: If OpenAI is unavailable (env var `OPENAI_API_KEY` not set, or API returns a non-200 after 3 retries), the endpoint returns the raw `BehaviourContext` data structure as JSON with `{ summary: null, data: ... }`. The UI renders a data table from the raw data instead of the narrative paragraph.

---

## 10. Data Model Reference

### Core Tenancy

```sql
organisations      (id, name, slug, created_at)
org_members        (org_id, user_id, role CHECK('owner','admin','member'), joined_at)
api_keys           (id, org_id, key_hash, prefix, name, created_at, last_used_at, revoked_at)
invitations        (id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by)
```

### Ingestion Infrastructure

```sql
ingestion_queue    (id, org_id, event_type, payload jsonb, idempotency_key, enqueued_at, attempts, last_error)
-- UNIQUE(org_id, idempotency_key)
rate_limit_state   (org_id PK, tokens float8, last_refill timestamptz)
```

### Error Tracking

```sql
error_groups       (id, org_id, fingerprint, title, culprit, status, first_seen, last_seen,
                    occurrence_count, user_count, resolved_at, regressed_at, resolved_by)
-- UNIQUE(org_id, fingerprint)
-- status: 'open' | 'resolved' | 'regressed' | 'ignored'

error_occurrences  (id, org_id, group_id, message, exception_type, stack_trace jsonb,
                    user_id, user_email, tags jsonb, breadcrumbs jsonb,
                    request_url, request_method, occurred_at, sdk_version, environment, release)
-- PARTITION BY RANGE (occurred_at) — monthly partitions
```

### Sessions

```sql
sessions           (id, org_id, session_id, anonymous_id, user_id, started_at, ended_at, duration_seconds)
session_events     (id, org_id, session_id, event_type, event_name, properties jsonb,
                    url, referrer, occurred_at)
identity_map       (org_id, anonymous_id, user_id, identified_at)
-- PK(org_id, anonymous_id)
```

### Performance

```sql
traces             (id, org_id, trace_id, span_id, parent_span_id, operation, duration_ms,
                    status, started_at, ended_at, tags jsonb, resource_attributes jsonb)
-- PARTITION BY RANGE (started_at) — monthly partitions

perf_aggregates_hourly  (org_id, operation, hour, p50, p90, p99, count, total_ms)
-- PK(org_id, operation, hour)
```

### Alerting

```sql
alerts             (id, org_id, type, metric_value, baseline_value, deviation_percent,
                    duration_minutes, started_at, resolved_at, ai_explanation, context jsonb)
-- No unique constraint; the cron jobs INSERT a fresh row on each detection tick
-- while the condition holds active.
```

---

*End of Architecture Document*
