# Thunder Client Test Data - Usage Guide

This file contains comprehensive test data for all event types supported by the Sanhok ingestion API.

## Setup

1. **Install Thunder Client** extension in VS Code
2. **Import the collection**: In Thunder Client, click Import → Browse → select `docs/thunder-client-test-data.json`
3. **Set your API key**:  
   - Open Thunder Client → Env tab
   - Create a new environment (e.g., "Sanhok Production")
   - Add variable:
     - `baseUrl`: `https://sanhok.vercel.app/api/ingest` (or your deployment URL)
     - `apiKey`: `{{API_KEY}}` (replace with your actual API key from Settings → API Keys in the dashboard)
   
   **To get your API key**:
   - Log in to your Sanhok dashboard
   - Navigate to Settings → API Keys
   - Create a new API key or copy an existing one
   - The key should start with `sk_live_` or `sk_test_`

## Test Coverage

### Error Events (Tests 1-3)
- **TypeError**: Common frontend error with stack trace and user context
- **DatabaseError**: Backend connection timeout with breadcrumbs
- **UnhandledPromiseRejection**: Async error with component tags

**What to verify**:
- Events appear in `error_groups` with correct fingerprinting (similar errors grouped)
- Stack traces are stored as JSONB
- `occurrence_count` increments on duplicate fingerprints
- User context (`user_id`, `user_email`) is preserved

### Activity Events (Tests 4-7)
- **Page view**: Basic navigation tracking
- **Custom event**: Button click with custom properties
- **Identify**: Anonymous-to-user stitching
- **Form submission**: Conversion event with metadata

**What to verify**:
- Sessions created with 30-minute idle timeout
- Events appear in `session_events` timeline
- `identify()` call retroactively updates `sessions.user_id`
- `identity_map` table records the anonymous → user mapping

### Trace Events (Tests 8-11)
- **HTTP request**: Standard API call (245ms)
- **Database query**: Child span with parent relationship
- **Slow query**: > 1 second duration for alert testing
- **Error status**: Failed request with error tags

**What to verify**:
- Traces appear in `traces` table
- Parent-child relationships preserved via `parent_span_id`
- `perf_aggregates_hourly` updated by pg_cron after 5 minutes
- Slow traces visible in `/performance` dashboard

### Edge Cases (Tests 12-14)
- **Multi-event batch**: Error + Activity in same request
- **Idempotency test**: Same `idempotency_key` sent twice (should process once)
- **Full user journey**: Complete funnel (anonymous → page view → click → identify → conversion)

## Running Tests

### 1. Single Test
Click any test → Send

Expected response:
```json
{
  "accepted": 1,
  "message": "Events accepted and queued for processing."
}
```

### 2. Batch Run
Select multiple tests → Run All

### 3. Validate Processing
After sending events, wait 60 seconds (for cron to drain queue), then run:

```sql
-- Check queue processed
SELECT COUNT(*) FROM ingestion_queue;  -- Should be 0 or low

-- Check errors appeared
SELECT title, occurrence_count, last_seen 
FROM error_groups 
WHERE org_id = '<your_org_id>'
ORDER BY last_seen DESC
LIMIT 5;

-- Check activity events
SELECT session_id, event_name, occurred_at
FROM session_events
WHERE org_id = '<your_org_id>'
ORDER BY occurred_at DESC
LIMIT 10;

-- Check traces
SELECT operation, duration_ms, status, started_at
FROM traces
WHERE org_id = '<your_org_id>'
ORDER BY started_at DESC
LIMIT 10;
```

## Customizing Tests

### Change Timestamps
All events use ISO 8601 timestamps (`2026-03-15T14:30:00Z`). Update to current time for realistic data:

```javascript
// Use Thunder Client pre-request script:
tc.setVar("timestamp", new Date().toISOString());
```

Then replace `occurred_at` values with `{{timestamp}}`.

### Change Organization
Replace the API key to test different organizations:
```json
"apiKey": "sk_live_your_org_api_key_here"
```

### Simulate Load
Use Thunder Client's **Run** feature with:
- Iterations: 10
- Delay: 100ms

This sends 10 copies of each event (with unique idempotency keys if you update them).

## Expected Results

### Error Grouping
Tests 1 and 3 (`TypeError`) should create **separate groups** due to different fingerprints.  
If you send Test 1 multiple times with different `idempotency_key`, `occurrence_count` should increment.

### Session Continuity
Tests 4-7 share `session_id: "sess_abc123def456"`:
- First event creates the session
- Test 6 (identify) retroactively sets `user_id` for the entire session
- All events appear in chronological order in the session timeline

### Trace Hierarchy
Tests 8-9 form a parent-child trace:
- `trace_id: "trace_http_001"` links them
- Test 9 has `parent_span_id: "span_001"` (from Test 8)
- Dashboard should show nested trace visualization

### Idempotency Check
Send Test 13 twice:
- Both return `200 OK`
- Database shows only 1 occurrence
- Second request does `INSERT ... ON CONFLICT DO NOTHING`

## Troubleshooting

### 401 Unauthorized
- Check API key is correct
- Verify key not revoked: `SELECT revoked_at FROM api_keys WHERE key_hash = encode(sha256('your_key_here'), 'hex')`

### 429 Rate Limited
- Org exceeded 1,000 events/minute
- Wait for token bucket refill (check `Retry-After` header)

### 200 OK but No Data in Dashboard
- Queue drainer not running → see [README Troubleshooting](../README.md#queue-drainer-not-processing-events-stuck-in-ingestion_queue)
- Check `ingestion_queue` table: `SELECT COUNT(*), MIN(attempts), MAX(last_error) FROM ingestion_queue`
- If `attempts >= 5`, events are dead-lettered → check `last_error` column

### Invalid JSON Error
- Verify all required fields present (see schema in `src/app/api/ingest/route.ts`)
- Check JSON syntax (no trailing commas, proper quotes)

## Performance Notes

- Each test sends 1-5 events (10-50 KB payload)
- Ingestion endpoint ~5ms latency (just writes to queue)
- Events queryable within 60 seconds (cron drain interval)
- Batch of 14 tests = ~14 events total → processes in single cron tick
