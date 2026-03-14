import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { explainAlert } from '@/lib/ai/explain'
import { z } from 'zod'

const BodySchema = z.object({
  alertId: z.string().uuid(),
  orgSlug: z.string().min(1).optional(),
})

/**
 * POST /api/ai/explain-alert
 *
 * Fetches an alert, calls OpenAI to generate a plain-language explanation,
 * and persists it to alerts.ai_explanation.
 *
 * Auth modes:
 *   1. Session cookie (dashboard-triggered)
 *   2. X-Internal-Key header (pg_net-triggered after alert INSERT)
 *
 * Degrades gracefully: if OPENAI_API_KEY is absent or the call fails,
 * returns { explanation: null } — the alert row is unaffected.
 */
export async function POST(request: NextRequest) {
  const internalKey = request.headers.get('x-internal-key')
  const isInternalCall =
    internalKey &&
    process.env.INTERNAL_API_SECRET &&
    internalKey === process.env.INTERNAL_API_SECRET

  // For session-auth calls, verify the user is authenticated upfront
  let sessionUserId: string | null = null
  if (!isInternalCall) {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    sessionUserId = user.id
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 422 })
  }

  const { alertId, orgSlug } = parsed.data
  const svc = createSupabaseServiceClient()

  // Fetch alert (using service client — RLS not relevant here as we verify membership below)
  const { data: alert, error: alertErr } = await svc
    .from('alerts')
    .select(
      'id, org_id, type, metric_value, baseline_value, deviation_percent, duration_minutes, context, ai_explanation'
    )
    .eq('id', alertId)
    .single()

  if (alertErr || !alert) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
  }

  // For session-auth calls, verify the user belongs to the alert's org
  if (!isInternalCall && sessionUserId) {
    if (orgSlug) {
      const membership = await resolveOrgMembership(sessionUserId, orgSlug)
      if (!membership || membership.orgId !== alert.org_id) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
    } else {
      // Without orgSlug, verify membership by org_id directly
      const { data: member } = await svc
        .from('org_members')
        .select('role')
        .eq('org_id', alert.org_id)
        .eq('user_id', sessionUserId)
        .single()
      if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  }

  const ctx = alert.context as Record<string, unknown> | null

  const explanation = await explainAlert({
    metric: alert.type,
    baseline_ms: Number(alert.baseline_value),
    observed_ms: Number(alert.metric_value),
    deviation_pct: Number(alert.deviation_percent),
    operation: ctx?.operation ? String(ctx.operation) : undefined,
    slope_ms_per_hour:
      ctx?.slope_ms_per_hour !== undefined ? Number(ctx.slope_ms_per_hour) : undefined,
  })

  if (!explanation) {
    return NextResponse.json({ explanation: null, reason: 'AI unavailable' })
  }

  const aiText = [explanation.summary, explanation.probable_cause, '→', explanation.recommended_action]
    .filter(Boolean)
    .join(' ')

  await svc.from('alerts').update({ ai_explanation: aiText }).eq('id', alertId)

  return NextResponse.json({ explanation })
}
