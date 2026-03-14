/**
 * Seed script — populates the database with demo data meeting all submission requirements:
 *   ✓ 3+ organisations
 *   ✓ 1+ detected anomaly with full alert (error_spike + latency_drift, each with AI explanation)
 *   ✓ 1+ replayable user session with a full event timeline
 *   ✓ 1+ latency degradation visible in the performance trend charts
 *
 * Run: npm run seed
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 *
 * Safe to run multiple times — all inserts are conditional or upserted.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── Helpers ────────────────────────────────────────────────────────────────
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const rndId = () => randomBytes(8).toString('hex')
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

async function insert<T extends object>(
  table: string,
  rows: T | T[],
  opts?: { onConflict?: string; chunk?: number }
): Promise<void> {
  const arr = Array.isArray(rows) ? rows : [rows]
  const chunkSize = opts?.chunk ?? 500
  for (let i = 0; i < arr.length; i += chunkSize) {
    const batch = arr.slice(i, i + chunkSize)
    const q = db.from(table)
    const res = opts?.onConflict
      ? await q.upsert(batch, { onConflict: opts.onConflict })
      : await q.insert(batch)
    if (res.error) {
      // Ignore duplicate-key errors during re-runs
      if (!res.error.message.includes('duplicate') && !res.error.message.includes('unique')) {
        console.error(`  ✗ ${table}: ${res.error.message}`)
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function seed() {
  console.log('🌱 Seeding Sanhok demo database…\n')

  // ── 1. Users ──────────────────────────────────────────────────────────────
  console.log('▸ Users')
  const seedUsers = [
    { email: 'alice@acme.example', password: 'SeedDemo1234!' },
    { email: 'bob@betalabs.example', password: 'SeedDemo1234!' },
    { email: 'carol@gamma.example', password: 'SeedDemo1234!' },
  ]
  const userIds: string[] = []
  const { data: allUsers } = await db.auth.admin.listUsers({ perPage: 200 })
  for (const u of seedUsers) {
    const existing = allUsers?.users.find((usr) => usr.email === u.email)
    if (existing) {
      userIds.push(existing.id)
      console.log(`  ↩ ${u.email}`)
      continue
    }
    const { data, error } = await db.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
    })
    if (error || !data.user) {
      console.error(`  ✗ ${u.email}: ${error?.message}`)
      process.exit(1)
    }
    userIds.push(data.user.id)
    console.log(`  ✓ ${u.email}`)
  }
  const [aliceId, bobId, carolId] = userIds

  // ── 2. Organisations ──────────────────────────────────────────────────────
  console.log('\n▸ Organisations')
  const orgDefs = [
    { name: 'Acme Corp', slug: 'acme', ownerId: aliceId },
    { name: 'Beta Labs', slug: 'beta-labs', ownerId: bobId },
    { name: 'Gamma Systems', slug: 'gamma', ownerId: carolId },
  ]
  const orgIds: string[] = []
  for (const org of orgDefs) {
    const { data: existing } = await db
      .from('organisations')
      .select('id')
      .eq('slug', org.slug)
      .maybeSingle()
    if (existing) {
      orgIds.push(existing.id)
      console.log(`  ↩ ${org.slug}`)
      continue
    }
    const { data, error } = await db.rpc('create_org_with_owner', {
      p_user_id: org.ownerId,
      p_org_name: org.name,
      p_org_slug: org.slug,
    })
    if (error) {
      console.error(`  ✗ ${org.slug}: ${error.message}`)
      process.exit(1)
    }
    orgIds.push(data as string)
    console.log(`  ✓ ${org.slug} (${data})`)
  }
  const [acmeId, betaId, gammaId] = orgIds

  // ── 3. API keys ───────────────────────────────────────────────────────────
  console.log('\n▸ API keys')
  const keyDefs = [
    { orgId: acmeId, raw: 'sk_live_acme_seed_do_not_use_in_real_prod_abc123', name: 'Seed key' },
    { orgId: betaId, raw: 'sk_live_beta_seed_do_not_use_in_real_prod_def456', name: 'Seed key' },
    { orgId: gammaId, raw: 'sk_live_gamma_seed_do_not_use_in_real_prod_ghi789', name: 'Seed key' },
  ]
  for (const k of keyDefs) {
    const keyHash = sha256(k.raw)
    const { data: existing } = await db
      .from('api_keys')
      .select('id')
      .eq('key_hash', keyHash)
      .maybeSingle()
    if (existing) {
      console.log(`  ↩ key for ${k.orgId.slice(0, 8)}…`)
      continue
    }
    await insert('api_keys', {
      org_id: k.orgId,
      key_hash: keyHash,
      prefix: k.raw.substring(0, 16),
      name: k.name,
    })
    console.log(`  ✓ ${k.raw.substring(0, 16)}… for ${k.orgId.slice(0, 8)}…`)
  }

  // ── 4. Acme — errors ──────────────────────────────────────────────────────
  console.log('\n▸ Errors (Acme)')
  await seedErrors(acmeId)

  // ── 5. Acme — replayable session ──────────────────────────────────────────
  console.log('\n▸ Replayable session (Acme)')
  await seedSession(acmeId)

  // ── 6. Acme — performance traces + latency drift ──────────────────────────
  console.log('\n▸ Performance traces & latency drift (Acme)')
  await seedPerformance(acmeId)

  // ── 7. Acme — alerts with AI explanation ──────────────────────────────────
  console.log('\n▸ Alerts (Acme)')
  await seedAlerts(acmeId)

  // ── 8. Minimal data for Beta and Gamma ────────────────────────────────────
  console.log('\n▸ Minimal data (Beta Labs, Gamma Systems)')
  await seedOrg(betaId, 'Beta Labs')
  await seedOrg(gammaId, 'Gamma Systems')

  console.log('\n✅ Seed complete!\n')
  console.log('Login credentials (all share password: SeedDemo1234!)')
  console.log('  alice@acme.example   → /acme          (errors + sessions + perf + alerts)')
  console.log('  bob@betalabs.example → /beta-labs     (minimal)')
  console.log('  carol@gamma.example  → /gamma         (minimal)')
}

// ── Error seeding ──────────────────────────────────────────────────────────
async function seedErrors(orgId: string) {
  type ErrGroup = {
    fingerprint: string
    title: string
    culprit: string
    status: 'open' | 'resolved'
    occurrences: number
    users: number
  }

  const stackTrace = [
    { file: 'src/components/UserProfile.tsx', function: 'render', lineno: 42 },
    { file: 'src/lib/hooks/useUser.ts', function: 'useUser', lineno: 18 },
    { file: 'src/pages/profile/[id].tsx', function: 'ProfilePage', lineno: 7 },
  ]

  const groups: ErrGroup[] = [
    {
      fingerprint: sha256('TypeError|Cannot-read-prop-undefined|src/components/UserProfile.tsx:render'),
      title: "TypeError: Cannot read properties of undefined (reading 'name')",
      culprit: 'src/components/UserProfile.tsx in render()',
      status: 'open',
      occurrences: 47,
      users: 12,
    },
    {
      fingerprint: sha256('UnhandledRejection|Failed-to-fetch|src/lib/api.ts:fetchUser'),
      title: 'Unhandled Promise Rejection: Failed to fetch /api/users',
      culprit: 'src/lib/api.ts in fetchUser()',
      status: 'open',
      occurrences: 203,
      users: 38,
    },
    {
      fingerprint: sha256('Error|User-not-found-normalized|src/services/UserService.ts:getUser'),
      title: "Error: User <id> not found",
      culprit: 'src/services/UserService.ts in getUser()',
      status: 'resolved',
      occurrences: 8,
      users: 5,
    },
  ]

  for (const g of groups) {
    const { data: existing } = await db
      .from('error_groups')
      .select('id')
      .eq('org_id', orgId)
      .eq('fingerprint', g.fingerprint)
      .maybeSingle()
    if (existing) {
      console.log(`  ↩ "${g.title.slice(0, 50)}…"`)
      continue
    }

    const { data: group, error } = await db
      .from('error_groups')
      .insert({
        org_id: orgId,
        fingerprint: g.fingerprint,
        title: g.title,
        culprit: g.culprit,
        status: g.status,
        first_seen: daysAgo(14).toISOString(),
        last_seen: hoursAgo(2).toISOString(),
        occurrence_count: g.occurrences,
        user_count: g.users,
        ...(g.status === 'resolved' ? { resolved_at: daysAgo(2).toISOString() } : {}),
      })
      .select('id')
      .single()

    if (error || !group) { console.error(`  ✗ error_groups: ${error?.message}`); continue }

    const occurrences = Array.from({ length: Math.min(g.occurrences, 15) }, (_, i) => ({
      org_id: orgId,
      group_id: group.id,
      message: g.title,
      exception_type: g.title.split(':')[0],
      stack_trace: stackTrace,
      user_id: `user_${(i % g.users) + 1}`,
      request_url: 'https://app.acme.example/dashboard',
      request_method: 'GET',
      occurred_at: hoursAgo(i * 2).toISOString(),
      environment: 'production',
      release: 'v2.4.1',
    }))

    await insert('error_occurrences', occurrences)
    console.log(`  ✓ "${g.title.slice(0, 50)}…" (${g.occurrences} occurrences)`)
  }
}

// ── Replayable session ─────────────────────────────────────────────────────
async function seedSession(orgId: string) {
  const SESSION_ID = 'sess_seed_replayable_001'
  const ANON_ID = 'anon_device_seed_abc123'
  const USER_ID = 'user_alice_identified'

  const { data: existing } = await db
    .from('sessions')
    .select('id')
    .eq('org_id', orgId)
    .eq('session_id', SESSION_ID)
    .maybeSingle()

  if (!existing) {
    const start = hoursAgo(4)
    const end = new Date(start.getTime() + 9 * 60_000) // 9 minutes

    await insert('sessions', {
      org_id: orgId,
      session_id: SESSION_ID,
      anonymous_id: ANON_ID,
      user_id: USER_ID,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      duration_seconds: 540,
    })

    await db.from('identity_map').upsert(
      { org_id: orgId, anonymous_id: ANON_ID, user_id: USER_ID, identified_at: new Date(start.getTime() + 95_000).toISOString() },
      { onConflict: 'org_id,anonymous_id' }
    )

    const timeline = [
      { type: 'page_view', name: 'Viewed homepage', url: 'https://app.acme.example/', t: 0 },
      { type: 'page_view', name: 'Viewed pricing', url: 'https://app.acme.example/pricing', t: 45_000 },
      { type: 'click', name: 'Clicked "Start free trial"', url: 'https://app.acme.example/pricing', t: 88_000 },
      { type: 'page_view', name: 'Viewed signup', url: 'https://app.acme.example/signup', t: 92_000 },
      { type: 'identify', name: 'User identified', url: 'https://app.acme.example/signup', t: 95_000 },
      { type: 'form_submit', name: 'Submitted signup form', url: 'https://app.acme.example/signup', t: 148_000 },
      { type: 'page_view', name: 'Viewed dashboard', url: 'https://app.acme.example/dashboard', t: 180_000 },
      { type: 'custom', name: 'Feature: Opened errors list', url: 'https://app.acme.example/dashboard/errors', t: 220_000 },
      { type: 'custom', name: 'Feature: Opened error detail', url: 'https://app.acme.example/dashboard/errors/abc', t: 260_000 },
      { type: 'click', name: 'Clicked Resolve', url: 'https://app.acme.example/dashboard/errors/abc', t: 295_000 },
      { type: 'page_view', name: 'Viewed performance', url: 'https://app.acme.example/dashboard/performance', t: 340_000 },
      { type: 'error', name: 'JS error: Chart render failed', url: 'https://app.acme.example/dashboard/performance', t: 355_000 },
      { type: 'page_view', name: 'Viewed settings', url: 'https://app.acme.example/dashboard/settings', t: 400_000 },
      { type: 'custom', name: 'Feature: Created API key', url: 'https://app.acme.example/dashboard/settings', t: 460_000 },
    ]

    const events = timeline.map((e) => ({
      org_id: orgId,
      session_id: SESSION_ID,
      event_type: e.type as 'page_view' | 'custom' | 'identify' | 'click' | 'form_submit' | 'error',
      event_name: e.name,
      url: e.url,
      occurred_at: new Date(start.getTime() + e.t).toISOString(),
      properties: e.type === 'identify' ? { user_id: USER_ID } : null,
    }))

    await insert('session_events', events)
    console.log(`  ✓ Replayable session (${SESSION_ID}, ${events.length} events, ${USER_ID})`)
  } else {
    console.log('  ↩ Replayable session already exists')
  }

  // Additional anonymous sessions
  let newCount = 0
  for (let i = 1; i <= 5; i++) {
    const sid = `sess_seed_extra_${String(i).padStart(3, '0')}`
    const { data: ex } = await db.from('sessions').select('id').eq('org_id', orgId).eq('session_id', sid).maybeSingle()
    if (ex) continue
    const t = hoursAgo(Math.floor(i * 12 + Math.random() * 6))
    await insert('sessions', {
      org_id: orgId, session_id: sid, anonymous_id: `anon_device_extra_${i}`,
      started_at: t.toISOString(),
      ended_at: new Date(t.getTime() + (60 + i * 90) * 1000).toISOString(),
      duration_seconds: 60 + i * 90,
    })
    await insert('session_events', [
      { org_id: orgId, session_id: sid, event_type: 'page_view', event_name: 'Viewed homepage', url: 'https://app.acme.example/', occurred_at: t.toISOString() },
      { org_id: orgId, session_id: sid, event_type: 'page_view', event_name: 'Viewed pricing', url: 'https://app.acme.example/pricing', occurred_at: new Date(t.getTime() + 30_000).toISOString() },
    ])
    newCount++
  }
  if (newCount > 0) console.log(`  ✓ ${newCount} additional anonymous sessions`)
}

// ── Performance traces + latency drift ─────────────────────────────────────
async function seedPerformance(orgId: string) {
  // Check if data already exists
  const { count } = await db.from('perf_aggregates_hourly').select('*', { count: 'exact', head: true }).eq('org_id', orgId)
  if ((count ?? 0) > 50) {
    console.log('  ↩ Performance data already seeded')
    return
  }

  const operations = [
    { name: 'GET /api/users', baseP50: 42, baseP90: 68, baseP99: 120 },
    { name: 'POST /api/orders', baseP50: 115, baseP90: 185, baseP99: 310 },
    // This one drifts — latency degradation scenario
    { name: 'GET /api/dashboard', baseP50: 78, baseP90: 125, baseP99: 210, drifts: true },
  ]

  const HOURS = 168 // 7 days of hourly data

  // Traces (raw spans — a sample, not all 168h×3ops×20)
  const traces: object[] = []
  for (let h = 24; h >= 1; h--) {
    for (const op of operations) {
      const drift = op.drifts ? 1 + Math.max(0, (24 - h) * 0.04) : 1
      for (let j = 0; j < 5; j++) {
        const dur = Math.round(op.baseP50 * drift * (0.7 + Math.random() * 0.9))
        const start = new Date(hoursAgo(h).getTime() + j * 120_000)
        traces.push({
          org_id: orgId,
          trace_id: `trace_seed_${rndId()}`,
          span_id: `span_seed_${rndId()}`,
          operation: op.name,
          duration_ms: dur,
          status: Math.random() < 0.02 ? 'error' : 'ok',
          started_at: start.toISOString(),
          ended_at: new Date(start.getTime() + dur).toISOString(),
        })
      }
    }
  }
  await insert('traces', traces, { chunk: 200 })
  console.log(`  ✓ ${traces.length} raw trace spans (last 24 h)`)

  // Hourly aggregates (full 7 days — these power the charts)
  const aggregates: object[] = []
  for (let h = HOURS; h >= 1; h--) {
    const hourTs = new Date(hoursAgo(h))
    hourTs.setMinutes(0, 0, 0)
    for (const op of operations) {
      // Drift: GET /api/dashboard drifts in the last 48 hours
      const drift = op.drifts ? 1 + Math.max(0, (48 - h) * 0.02) : 1
      const jitter = 0.9 + Math.random() * 0.2
      aggregates.push({
        org_id: orgId,
        operation: op.name,
        hour: hourTs.toISOString(),
        p50: Math.round(op.baseP50 * drift * jitter),
        p90: Math.round(op.baseP90 * drift * jitter),
        p99: Math.round(op.baseP99 * drift * jitter),
        sample_count: 18,
        total_ms: Math.round(op.baseP50 * drift * 18 * jitter),
      })
    }
  }
  await insert('perf_aggregates_hourly', aggregates, { onConflict: 'org_id,operation,hour', chunk: 300 })
  console.log(`  ✓ ${aggregates.length} hourly perf aggregates (7 days, 3 operations)`)
  console.log('  ✓ GET /api/dashboard shows ~96% p99 latency drift over last 48 h')
}

// ── Alerts with pre-populated AI explanation ───────────────────────────────
async function seedAlerts(orgId: string) {
  const { count } = await db.from('alerts').select('*', { count: 'exact', head: true }).eq('org_id', orgId)
  if ((count ?? 0) > 0) { console.log('  ↩ Alerts already exist'); return }

  await insert('alerts', [
    {
      org_id: orgId,
      type: 'error_spike',
      metric_value: 47,
      baseline_value: 8.2,
      deviation_percent: 472.6,
      duration_minutes: 5,
      started_at: hoursAgo(2).toISOString(),
      ai_explanation:
        'Error rate spiked 473% above the 1-hour baseline, reaching 47 errors in the last 5-minute window. ' +
        'The spike correlates with the v2.4.1 deploy and TypeError occurrences in UserProfile.tsx. ' +
        '→ Roll back v2.4.1 or hot-fix the undefined property access in the render function.',
      context: null,
    },
    {
      org_id: orgId,
      type: 'latency_drift',
      metric_value: 403,
      baseline_value: 210,
      deviation_percent: 91.9,
      duration_minutes: 1440,
      started_at: hoursAgo(6).toISOString(),
      ai_explanation:
        'GET /api/dashboard p99 latency has been rising at +3.8 ms/hour over 24 h, now at 403 ms vs a 210 ms baseline (92% above). ' +
        'No corresponding error spike suggests a data-volume or query-plan issue, not a code error. ' +
        '→ Run EXPLAIN ANALYZE on the dashboard aggregation query and check for missing indexes on perf_aggregates_hourly.',
      context: { operation: 'GET /api/dashboard', slope_ms_per_hour: 3.8 },
    },
  ])
  console.log('  ✓ error_spike + latency_drift alerts with AI explanations')
}

// ── Minimal data for secondary orgs ───────────────────────────────────────
async function seedOrg(orgId: string, label: string) {
  const fp = sha256(`${orgId}-minimal-err-1`)
  const { data: existing } = await db.from('error_groups').select('id').eq('org_id', orgId).eq('fingerprint', fp).maybeSingle()
  if (existing) { console.log(`  ↩ ${label} already seeded`); return }

  await insert('error_groups', {
    org_id: orgId,
    fingerprint: fp,
    title: "ReferenceError: Cannot access 'config' before initialization",
    culprit: 'src/config/index.ts in loadConfig()',
    status: 'open',
    first_seen: daysAgo(3).toISOString(),
    last_seen: hoursAgo(5).toISOString(),
    occurrence_count: 5,
    user_count: 3,
  })

  const sid = `sess_seed_${orgId.slice(0, 8)}_001`
  await insert('sessions', {
    org_id: orgId, session_id: sid, anonymous_id: `anon_${orgId.slice(0, 8)}`,
    started_at: hoursAgo(8).toISOString(),
    ended_at: hoursAgo(7.9).toISOString(),
    duration_seconds: 360,
  })
  await insert('session_events', [{
    org_id: orgId, session_id: sid, event_type: 'page_view',
    event_name: 'Viewed homepage', url: 'https://app.example/', occurred_at: hoursAgo(8).toISOString(),
  }])

  console.log(`  ✓ ${label} (1 error group, 1 session)`)
}

// ── Run ────────────────────────────────────────────────────────────────────
seed().catch((err: unknown) => {
  console.error('\nSeed failed:', err)
  process.exit(1)
})
