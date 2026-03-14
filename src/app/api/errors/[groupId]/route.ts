import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { z } from 'zod'

const PatchSchema = z.object({
  status: z.enum(['open', 'resolved', 'ignored']),
  orgSlug: z.string().min(1),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const { groupId } = await params

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 422 })
  }

  const { status, orgSlug } = parsed.data
  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const svc = createSupabaseServiceClient()

  const updatePayload: Record<string, unknown> = { status }
  if (status === 'resolved') {
    updatePayload.resolved_at = new Date().toISOString()
    updatePayload.resolved_by = user.id
  } else if (status === 'open') {
    updatePayload.resolved_at = null
    updatePayload.resolved_by = null
  }

  const { error } = await svc
    .from('error_groups')
    .update(updatePayload)
    .eq('id', groupId)
    .eq('org_id', membership.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ status })
}
