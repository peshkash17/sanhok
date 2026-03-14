import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import OpenAI from 'openai'

/**
 * GET /api/ai/behaviour-summary?orgSlug=&from=&to=
 *
 * Assembles org-level user behaviour data for the requested window, compares
 * it to the prior equivalent period, and generates a plain-language summary.
 *
 * Always returns { summary, data } where:
 *   - data: raw aggregates (always present)
 *   - summary: AI narrative (null if OPENAI_API_KEY absent or call fails)
 *
 * What stops working without AI: only `summary` is null.
 * The raw `data` object is always returned and the UI renders it as a table.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get('orgSlug')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (!orgSlug || !from || !to) {
    return NextResponse.json({ error: 'orgSlug, from, and to are required' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  const fromDate = new Date(from)
  const toDate = new Date(to)
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 })
  }

  // Calculate prior period (same duration immediately before)
  const durationMs = toDate.getTime() - fromDate.getTime()
  const priorFrom = new Date(fromDate.getTime() - durationMs).toISOString()
  const priorTo = fromDate.toISOString()

  // Fetch all data in parallel
  const [
    { data: sessions },
    { data: priorSessions },
    { data: topEvents },
    { data: priorTopEvents },
    { count: errorCount },
    { count: priorErrorCount },
  ] = await Promise.all([
    svc
      .from('sessions')
      .select('user_id, duration_seconds')
      .eq('org_id', orgId)
      .gte('started_at', from)
      .lte('started_at', to)
      .limit(5000),
    svc
      .from('sessions')
      .select('user_id, duration_seconds')
      .eq('org_id', orgId)
      .gte('started_at', priorFrom)
      .lte('started_at', priorTo)
      .limit(5000),
    svc
      .from('session_events')
      .select('event_name, event_type')
      .eq('org_id', orgId)
      .gte('occurred_at', from)
      .lte('occurred_at', to)
      .limit(5000),
    svc
      .from('session_events')
      .select('event_name, event_type')
      .eq('org_id', orgId)
      .gte('occurred_at', priorFrom)
      .lte('occurred_at', priorTo)
      .limit(5000),
    svc
      .from('error_occurrences')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('occurred_at', from)
      .lte('occurred_at', to),
    svc
      .from('error_occurrences')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('occurred_at', priorFrom)
      .lte('occurred_at', priorTo),
  ])

  // Aggregate top events
  const eventCounts: Record<string, number> = {}
  topEvents?.forEach((e) => {
    const key = (e.event_name || e.event_type) as string
    eventCounts[key] = (eventCounts[key] ?? 0) + 1
  })
  const priorEventCounts: Record<string, number> = {}
  priorTopEvents?.forEach((e) => {
    const key = (e.event_name || e.event_type) as string
    priorEventCounts[key] = (priorEventCounts[key] ?? 0) + 1
  })

  const topEventList = Object.entries(eventCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count, prior_count: priorEventCounts[name] ?? 0 }))

  // New vs returning users (null user_ids are anonymous sessions)
  const currentUserIds = new Set(
    (sessions ?? []).map((s) => s.user_id).filter((id): id is string => Boolean(id))
  )
  const priorUserIds = new Set(
    (priorSessions ?? []).map((s) => s.user_id).filter((id): id is string => Boolean(id))
  )
  const newUsers = [...currentUserIds].filter((id) => !priorUserIds.has(id)).length
  const returningUsers = [...currentUserIds].filter((id) => priorUserIds.has(id)).length

  // Median session duration (seconds)
  const durations = (sessions ?? [])
    .map((s) => s.duration_seconds ?? 0)
    .filter((d): d is number => d > 0)
    .sort((a, b) => a - b)
  const medianDuration =
    durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0

  const sessionCount = sessions?.length ?? 0
  const priorSessionCount = priorSessions?.length ?? 0

  const data = {
    period: { from, to },
    priorPeriod: { from: priorFrom, to: priorTo },
    sessionCount,
    priorSessionCount,
    topEvents: topEventList,
    newUsers,
    returningUsers,
    medianSessionDuration: medianDuration,
    errorCount: errorCount ?? 0,
    priorErrorCount: priorErrorCount ?? 0,
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ summary: null, data })
  }

  const sessionChange =
    priorSessionCount > 0
      ? `${(((sessionCount - priorSessionCount) / priorSessionCount) * 100).toFixed(0)}%`
      : 'N/A (no prior data)'

  const errorCurr = errorCount ?? 0
  const errorPrior = priorErrorCount ?? 0
  const errorChange =
    errorPrior > 0 ? `${(((errorCurr - errorPrior) / errorPrior) * 100).toFixed(0)}%` : 'N/A'

  const prompt = `You are a product analytics expert summarising user behaviour for an engineering team.

Time window: ${from} to ${to}
Prior period: ${priorFrom} to ${priorTo}

Metrics:
- Sessions: ${sessionCount} (prior: ${priorSessionCount}, change: ${sessionChange})
- Identified users — New: ${newUsers}, Returning: ${returningUsers}
- Median session duration: ${medianDuration}s
- Errors: ${errorCurr} (prior: ${errorPrior}, change: ${errorChange})
- Top events: ${topEventList.map((e) => `${e.name} ×${e.count} (was ×${e.prior_count})`).join(', ') || 'none'}

Write a plain-language summary (3–4 sentences) for a product or ops team. Compare to the prior period. Note the most significant changes. Do not exceed 80 words.`

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.AI_BASE_URL ?? undefined,
    })
    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    })
    const summary = response.choices[0]?.message?.content ?? null
    return NextResponse.json({ summary, data })
  } catch {
    return NextResponse.json({ summary: null, data })
  }
}
