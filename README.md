# Sanhok — Self-Hosted Observability Platform

A self-hosted observability platform in the spirit of Sentry + PostHog. Engineers and product teams
use the dashboard to monitor errors, user behaviour, performance, and system health. Multi-tenant
from the ground up, with isolation enforced at the database layer.

**Stack:** Next.js App Router · Supabase (Postgres + Auth + pg_cron + pg_net) · TypeScript · Tailwind CSS v4

---

## Quick start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.local.example .env.local
# Fill in: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#          SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (optional),
#          INTERNAL_API_SECRET (random string for the AI trigger webhook)

# Run migrations in the Supabase SQL editor (in order):
#   supabase/migrations/001_schema.sql
#   supabase/migrations/002_cron_jobs.sql
#   supabase/migrations/003_rate_limit_fn.sql
#   supabase/migrations/004_helper_functions.sql
#   supabase/migrations/005_alert_trigger.sql   ← requires pg_net extension
#   supabase/migrations/006_app_config.sql      ← config table for AI trigger
#   supabase/migrations/007_queue_drain_function.sql  ← fixes unreliable 10s cron

# Seed demo data (3 orgs, a detected anomaly with AI explanation,
#                 a replayable user session, and latency degradation in trends)
npm run seed

# Start dev server
npm run dev
```

### Seed login credentials (password: `SeedDemo1234!`)

| Email | Dashboard URL | Content |
|---|---|---|
| alice@acme.example | `/acme` | Full data: errors with stack traces, active alert, replayable session, latency drift |
| bob@betalabs.example | `/beta-labs` | Minimal baseline data |
| carol@gamma.example | `/gamma` | Minimal baseline data |

**Note**: Migration 006 creates the `app_config` table with placeholder values. Update these in Supabase SQL Editor after deployment:
```sql
UPDATE app_config SET value = 'https://your-app.vercel.app' WHERE key = 'api_base_url';
UPDATE app_config SET value = '<your_INTERNAL_API_SECRET>' WHERE key = 'internal_api_secret';
```

This enables the AI explanation trigger to work. See **Troubleshooting** section if alerts are created but `ai_explanation` stays NULL.

---

## The four pillars

### Error tracking

Similar errors are grouped into *issues* rather than being listed individually. Exact message
matching is insufficient — dynamic values (user IDs, record numbers, email addresses, request IDs)
make every occurrence look unique even when they share the same root cause and code path.

**Fingerprinting algorithm:**
1. Normalise the message — strip UUIDs, integers, emails, URLs, and quoted strings with regex,
   replacing them with typed placeholders (`<uuid>`, `<n>`, `<email>`, `<url>`, `<str>`).
2. Extract the top 3 non-vendor stack frames, using `file + function` (not line number). Line
   numbers change on every deploy; function names are stable across refactors within a file.
3. SHA-256 of `exception_type | normalised_message | frame1 | frame2 | frame3`.

This collapses "User 'alice@example.com' not found", "User 'bob@corp.com' not found" into a
single issue, and keeps the issue alive across deploys when line numbers shift.

**Issue lifecycle:** `open → resolved → regressed`. Regression is detected automatically: when a
new occurrence arrives for a group with `status = 'resolved'`, the group transitions to `regressed`
and an `error_regression` alert is created.

**Stored per occurrence:** raw message, exception type, full structured stack trace (JSONB),
user ID/email, tags, breadcrumbs, request URL/method, environment, release tag.

---

### Session & activity tracking

Sessions are reconstructed from `activity` events using a 30-minute idle timeout (matching the
Google Analytics convention). `ended_at` is a projection (`last_event + 30 min`), not a confirmed
close time.

**Anonymous-to-identified stitching (retroactive):** when an `identify(anonymous_id, user_id)`
call arrives, the queue drainer immediately upserts `identity_map` and runs:
```sql
UPDATE sessions SET user_id = $user_id
WHERE org_id = $org_id AND anonymous_id = $anonymous_id AND user_id IS NULL;
```
All prior sessions on that device are retroactively attributed within the same drainer tick —
no separate nightly batch job.

**Known edge cases this approach does not handle:**
- *Shared device* — the last `identify()` call wins; earlier sessions are attributed to the most recent user. Undetectable without additional signals.
- *Cross-device identity before identify()* — mobile and desktop sessions remain split until `identify()` is called on each device independently.
- *Large-scale retroactive stitching* — an anonymous_id with 50k sessions triggers a full-table `UPDATE`. Not chunked in the MVP; an O(n) operation on the sessions table.
- *Session boundary correctness* — a user leaving a tab open for >30 min then returning creates a new session. Standard industry behaviour; documented, not fixed.
- *Client clock skew* — SDK sends both `client_timestamp` and the server ingestion time; reconstruction uses server time if skew >5 minutes is detected.

---

### Performance monitoring

Traces follow the OpenTelemetry span model: `trace_id`, `span_id`, optional `parent_span_id`,
`operation` name, `duration_ms`, and `status`. The latency trend chart shows p50/p90/p99 over time
per operation. The slowest individual traces per operation are queryable from the raw `traces` table.

**How percentile queries stay fast at scale:**
- `perf_aggregates_hourly` is refreshed every 5 minutes by a pg_cron job using `percentile_disc`
  over traces within the current hour. All trend chart queries read this small pre-aggregate table — 
  never `traces` directly.
- Even at high load, one hour of traces for a single operation is bounded (~100–200k rows).
  `percentile_disc` on 200k rows runs in ~200ms.
- The dashboard shows "7-day peak p99 (hourly resolution)" — the maximum of 168 hourly p99 values.
  This is a conservative overestimate (the worst single hour), which is the right metric for
  detecting whether something is slow and is clearly labelled in the UI.

---

### Anomaly detection & alerting

Three structurally different algorithms for three structurally different anomaly shapes. A single
threshold approach (e.g. "alert if > N × average") handles step functions but fails at gradual
drift (the average rises alongside the metric) and misidentifies seasonal lows as anomalies.

**Error rate spike — control chart (±3σ)**
Groups `error_occurrences` into 5-minute buckets using modulo arithmetic
(`date_trunc('minute', t) - (EXTRACT(MINUTE FROM t)::int % 5) * interval '1 minute'`).
Fires when `current_bucket > mean + 3σ` and `current_bucket > 10` (floor suppresses 0→2 noise).
Runs every 5 minutes via pg_cron. **Minimum data required: 60 minutes (12 buckets).**

**Latency drift — OLS linear regression**
Fits a straight line through up to 24 hourly p90 values. Fires when `slope > 5 ms/hour` and
cumulative drift `> 20%` of baseline. Catches gradual monotonic degradation that never crosses a
fixed threshold. Runs every 30 minutes via pg_cron.
**Minimum data required: 8 hourly data points (8 hours).**

**User activity drop — seasonal comparison**
Compares the current hour-of-week session count to the mean of the same hour-of-week over the
prior 4 weeks, excluding the most recent 7 days (to prevent an ongoing anomaly from contaminating
the baseline). Fires when `current < mean − 2σ`. Runs every hour via pg_cron.
**Minimum data required: 4 weeks of history for the same hour-of-week.**

Every alert row stores: `type`, `metric_value`, `baseline_value`, `deviation_percent`,
`duration_minutes`, `started_at`, `resolved_at`, `context` (JSONB, type-specific extras),
and `ai_explanation` (populated asynchronously after INSERT if OpenAI is available).

---

## Ingestion architecture

```
Client SDK
    │  POST /api/ingest
    │  Authorization: Bearer sk_live_<key>
    │  Body: { idempotency_key, events: [...] }
    ▼
Next.js API route
    ├── SHA-256(key) → lookup api_keys table → resolve org_id
    ├── Token-bucket rate limit check via check_and_consume_tokens() Postgres function
    ├── 401 / 429 returned before touching the queue
    └── Zod validation — per-event-type schemas, all-or-nothing batch rejection
                    │
                    ▼
          ingestion_queue table
          INSERT … ON CONFLICT (org_id, idempotency_key) DO NOTHING
          ← caller gets 200 here (~5 ms)
                    │
         pg_cron every 10 seconds
                    ▼
          Queue drainer (SQL function)
          SELECT … FOR UPDATE SKIP LOCKED (batch of 500)
          Route by event_type:
            error    → error_occurrences + upsert error_groups (fingerprint match)
            activity → session_events + upsert sessions + identity stitching
            trace    → traces
          DELETE processed rows; increment attempts on failure; dead-letter at 5
                    │
          ~10 s after ingest call
                    ▼
           Event queryable in dashboard
```

**Idempotency:** `ingestion_queue` has `UNIQUE(org_id, idempotency_key)`. Retried requests with
the same key `INSERT … DO NOTHING` — the caller receives `200` with zero DB side-effects. Safe to
retry indefinitely without double-counting any event.

**Rate limiting:** token-bucket via the `check_and_consume_tokens` Postgres function.
Each org gets **1,000 tokens/minute**. Requests exceeding the budget return `429` with
`Retry-After` and `X-RateLimit-Remaining` headers.

**CORS:** `Access-Control-Allow-Origin: *` on all ingest responses; `OPTIONS` preflight returns
204. Browser SDKs can call this endpoint directly without a proxy.

**Failure modes:**

| Component | Impact | Recovery |
|---|---|---|
| DB down | Ingest returns 503; events lost unless client retries (idempotency prevents duplicates on retry) | Client retry with same `idempotency_key` |
| pg_cron drainer slow | Events acknowledged (200); queryable lag grows; dashboard shows stale data | Drainer auto-recovers when load drops |
| Drainer crash | Events sit in `ingestion_queue`; no data loss | pg_cron retries on next tick automatically |
| Rate limit contention | `rate_limit_state` row lock under very high concurrency | Fall back to allowing requests if lock wait exceeds threshold |

---

## Query strategy

**Principle: never aggregate at read time if you can aggregate at write time.**

**Layer 1 — running counters on parent rows.**
`error_groups.occurrence_count` and `.user_count` are maintained as running totals on every insert
into `error_occurrences`. Dashboard error cards read a single denormalised row — O(1) regardless
of occurrence volume. `user_count` uses a `COUNT(DISTINCT user_id)` sub-select scoped to the
group; this is bounded by group size, not total table size.

**Layer 2 — pre-aggregated hourly time-series.**
`perf_aggregates_hourly` stores one row per `(org_id, operation, hour)` with `p50`, `p90`, `p99`,
`sample_count`, and `total_ms` computed by `percentile_disc`. A pg_cron job upserts these every
5 minutes. All performance trend queries touch only this small table — never `traces` directly.

**Layer 3 — partition pruning.**
`error_occurrences` and `traces` are partitioned by month (`PARTITION BY RANGE (occurred_at)`).
Queries with `WHERE occurred_at >= …` skip prior-month heap files automatically.

**Key Postgres features:**
- `percentile_disc` — exact ordered-set aggregates, bounded by hourly bucket size, not total table size
- Declarative range partitioning — monthly partitions auto-pruned at query plan time
- `SELECT … FOR UPDATE SKIP LOCKED` — concurrent drainer invocations process separate rows without blocking each other
- `ON CONFLICT DO NOTHING / DO UPDATE` — atomic upserts for idempotency and aggregate maintenance without application-level locking
- Partial indexes — `WHERE attempts < 5` on `ingestion_queue` keeps the active-row index small; `WHERE resolved_at IS NULL` on `alerts` covers the active-alert query with minimal index size

**What breaks first at 2× volume:**
`error_groups.user_count` is maintained via `COUNT(DISTINCT user_id) … WHERE group_id = $1`.
At ~500k occurrences per group this sub-select takes ~200ms per insert even with the covering
index. Fix: switch to HyperLogLog approximate distinct counting (`pg_hll`) or a separate
`error_group_users(group_id, user_id UNIQUE)` join table counted with `count(*)`.

**What breaks second:** `percentile_disc` in the hourly refresh job sorts all traces in a one-hour
window per operation. At >1M traces/hour per operation, sorting that volume every 5 minutes is
expensive. Fix: pre-bucket into 5-minute windows and merge using t-digest approximate percentiles.

---

## Tenant isolation

Every org-scoped table carries `org_id NOT NULL REFERENCES organisations(id)`.

**Row-Level Security is enforced at the database layer:**
```sql
ALTER TABLE error_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON error_occurrences
    USING (org_id = (current_setting('app.current_org_id', true))::uuid);
```

`FORCE ROW LEVEL SECURITY` means the Supabase service role is also subject to RLS — there is no
privileged application-layer bypass path.

At the start of every API request the server resolves org_id from the authenticated credential
and immediately executes:
```sql
SET LOCAL app.current_org_id = '<resolved uuid>';
```

`SET LOCAL` is scoped to the current transaction and cannot bleed into the next request even on a
pooled PgBouncer connection. The `org_id` is **never** taken from the request body, query string,
or any client-supplied value — always resolved server-side from the authenticated API key hash or
session JWT.

**Realistic bypass scenario — Insecure Direct Object Reference:**
A developer writes a route that queries `error_occurrences` by `group_id` from the URL without an
explicit `AND org_id = $current` clause. An attacker from Org B submits a `group_id` belonging to
Org A. The RLS policy evaluates `org_id = (current_setting('app.current_org_id'))::uuid`; the rows
for Org A have a different `org_id`, so zero rows are returned. The database enforces isolation
even when the application code forgets to.

**Fail-safe:** if `SET LOCAL` is inadvertently omitted, `current_setting('app.current_org_id', true)`
returns `NULL`. `NULL = any_uuid` evaluates to `NULL` (falsy). The system returns zero rows rather
than leaking all rows — it **fails closed**.

**What RLS does not protect against:** a bug in the `SET LOCAL` call itself. Mitigation: the Supabase
DB role used by the API has RLS turned on with no default `app.current_org_id`, so a missing
`SET LOCAL` is guaranteed to return empty rather than everything.

---

## AI integration

**What stops working if `OPENAI_API_KEY` is absent:**
- `alerts.ai_explanation` remains `null`; alert cards display the raw numbers (type, metric, baseline, deviation, duration) without a prose paragraph
- `GET /api/ai/behaviour-summary` returns `{ summary: null, data: <raw aggregates> }`; the UI renders a data table from the raw data instead of a narrative
- Every other feature — ingestion, error tracking, sessions, performance charts, anomaly detection, alerting, auth, settings — is fully unaffected

**Anomaly explanation (`POST /api/ai/explain-alert`):**
After an alert row is inserted, a `pg_net` HTTP trigger (`005_alert_trigger.sql`) fires an async
POST to `/api/ai/explain-alert`. The handler assembles context (alert type, metric, baseline,
deviation, operation name, regression slope, co-occurring top errors, affected user count), calls
`gpt-4o`, and writes the result back to `alerts.ai_explanation`. The alert INSERT transaction
completes without waiting — explanation arrives seconds later.

**Behaviour summarisation (`GET /api/ai/behaviour-summary?orgSlug=&from=&to=`):**
Aggregates top pages, top events, new vs returning users, median session duration, and error count
for the requested window, then compares each metric to the prior equivalent period. Returns
`{ summary: string | null, data: BehaviourContext }`. Gracefully returns raw data if OpenAI
is unavailable, rate-limited, or times out after 3 retries.

---

## What isn't finished (prioritised)

The following features were cut in priority order, per the submission brief's guidance to cut AI
summarisation before ingestion reliability, and alerting UI before detection logic:

1. **Live dashboard auto-refresh** — the dashboard requires a page reload to see new events.
   Supabase Realtime `postgres_changes` subscriptions would resolve this. Cut because ingestion
   correctness was higher priority than display freshness.

2. **Individual trace drill-down** — `/performance` shows p50/p90/p99 trends per operation but
   does not link through to the individual slowest spans. The `traces` table, indexes, and query
   are ready; the UI page is not.

3. **Funnel / path analytics UI** — the SQL for step-sequence funnel queries is designed and
   documented in `docs/architecture.md`. No dashboard page exists. High value for product teams;
   deprioritised in favour of core error and performance views.

4. **Behaviour summary UI surface** — `/api/ai/behaviour-summary` is implemented and returns
   correctly structured data; it is not yet wired to a dashboard page.

5. **Role-gated UI** — roles are enforced at the DB and API layers (owner/admin/member). The UI
   does not preemptively hide admin-only actions; forbidden requests return an API error instead.

6. **Alert suppression / maintenance windows** — no way to silence a detector during a planned
   deploy or marketing campaign (known false-positive trigger). Documented in `docs/architecture.md`;
   not in MVP.

7. **Sampling** — at very high event volumes (>1M traces/hour) head-based sampling at the SDK
   would be the next scaling lever. The ingest API design accommodates it; nothing is implemented.

---

## What needs to change for 100+ real organisations

| Concern | Current state | Change needed |
|---|---|---|
| **Queue throughput** | Single Postgres instance; pg_cron drainer processes 500 rows every 10 s | Scale vertically first; then shard `ingestion_queue` by `org_id % N` for parallel drainer workers |
| **Partition management** | Monthly partitions created by pg_cron on the 1st of each month | Create 2 future partitions ahead of time as a safety buffer; CI check should alert if the next month's partition is missing |
| **`user_count` sub-select** | `COUNT(DISTINCT user_id)` per insert, bounded by group size | Replace with HyperLogLog (`pg_hll`) at ~50k occurrences per group; or maintain a `error_group_users(group_id, user_id UNIQUE)` join table |
| **Hourly perf aggregation** | `percentile_disc` over all traces in the current hour per operation | At >1M traces/hour per operation, pre-bucket into 5-min windows and merge with t-digest approximate percentiles |
| **Per-plan rate limits** | Flat 1,000 tokens/minute per org | Add `rate_limit_rpm` column to `organisations`; `check_and_consume_tokens` already accepts a configurable refill rate |
| **Monitoring the monitor** | Queue depth not exposed as a metric | Expose `SELECT count(*) FROM ingestion_queue` at `GET /api/health`; alert internally if depth exceeds 5,000 |
| **Migration delivery** | Manual SQL execution in Supabase SQL editor | Supabase CLI `supabase db push` triggered on merge to main via CI/CD |
| **Connection pooling** | Supabase PgBouncer transaction mode (correct default) | Increase pool size; add a read replica for dashboard queries to isolate analytics load from ingestion writes |
| **Retroactive identity stitching at scale** | Inline `UPDATE sessions … WHERE anonymous_id = $1` in the drainer | Chunk updates with `LIMIT/OFFSET` for anonymous IDs with >1k associated sessions; or queue to a separate reconciliation job |

---

## Troubleshooting

### AI Explanation Not Working (alerts.ai_explanation remains NULL)

**Symptom**: Alerts are created but `ai_explanation` column stays `NULL`. No HTTP requests appear in `net.http_request_queue` or `net._http_response`.

**Root cause**: The trigger function `fn_notify_alert_explanation()` reads configuration from `app_config` table, but Row-Level Security blocks access even inside `SECURITY DEFINER` functions.

**Fix** (already applied in migration 006):

1. Create a helper function that bypasses RLS:
```sql
CREATE OR REPLACE FUNCTION get_app_config(config_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  config_value text;
BEGIN
  SELECT value INTO config_value FROM app_config WHERE key = config_key;
  RETURN config_value;
END;
$$;
```

2. Add RLS policy to allow postgres role to read `app_config`:
```sql
CREATE POLICY "allow_postgres_read" ON app_config
  FOR SELECT
  TO postgres
  USING (true);
```

3. Update the trigger function to use the helper:
```sql
CREATE OR REPLACE FUNCTION fn_notify_alert_explanation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_api_base_url  text;
  v_internal_key  text;
BEGIN
  v_api_base_url := get_app_config('api_base_url');
  v_internal_key := get_app_config('internal_api_secret');

  IF v_api_base_url IS NULL OR v_api_base_url = ''
  OR v_internal_key IS NULL OR v_internal_key = '' OR v_internal_key = 'change_me'
  THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_api_base_url || '/api/ai/explain-alert',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'X-Internal-Key', v_internal_key
               ),
    body    := jsonb_build_object('alertId', NEW.id)::text,
    timeout_milliseconds := 10000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;
```

4. Verify config is accessible:
```sql
SELECT get_app_config('api_base_url') as base_url, 
       get_app_config('internal_api_secret') as secret;
```

If values return, insert a test alert to trigger the pipeline.

---

### Queue Drainer Not Processing Events (Stuck in ingestion_queue)

**Symptom**: Events are accepted (200 OK) but never appear in `error_groups`, `sessions`, or `traces`. `/api/ingest` returns success but dashboard shows no data.

**Root cause**: pg_cron with `'10 seconds'` interval is unreliable on Supabase hosted Postgres (free tier especially). Supabase doesn't guarantee sub-minute cron execution.

**Fix** (migration 007):

1. Extract drain logic into a reusable function:
```sql
CREATE OR REPLACE FUNCTION drain_ingestion_queue(batch_size int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
-- (full function body in migration 007_queue_drain_function.sql)
$$;
```

2. Update cron to run every minute (much more reliable):
```sql
SELECT cron.unschedule('drain-ingestion-queue');

SELECT cron.schedule(
    'drain-ingestion-queue',
    '* * * * *',  -- Every minute instead of 10 seconds
    $$ SELECT drain_ingestion_queue(500); $$
);
```

3. Verify cron is active:
```sql
SELECT jobname, schedule, active 
FROM cron.job 
WHERE jobname = 'drain-ingestion-queue';
```

Should show `active = true` and `schedule = * * * * *`.

4. Test manually:
```sql
SELECT drain_ingestion_queue(500);
```

Should return `{"processed": N, "failed": 0, "timestamp": "..."}`.

---

### Testing Ingestion End-to-End

Use the Thunder Client test data in `docs/thunder-client-test-data.json` covering all event types:

- **Error events** with stack traces, breadcrumbs, user context
- **Activity events** including page views, custom events, identify calls
- **Trace events** with parent-child relationships, slow queries
- **Multi-event batches** and idempotency tests
- **Full user journey** (anonymous → page view → click → identify → conversion)

Import into Thunder Client and run against `https://sanhok.vercel.app/api/ingest` with your API key.
