import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { z } from 'zod'

const patchSchema = z.object({
  orgSlug: z.string().min(1),
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member']),
})

const deleteSchema = z.object({
  orgSlug: z.string().min(1),
  userId: z.string().uuid(),
})

// PATCH /api/members — change a member's role
export async function PATCH(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 })
  }

  const { orgSlug, userId, role } = parsed.data

  if (userId === user.id) {
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 403 })
  }

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Only admins and owners can change roles' }, { status: 403 })
  }

  const svc = createSupabaseServiceClient()
  const { data: target } = await svc
    .from('org_members')
    .select('role')
    .eq('org_id', membership.orgId)
    .eq('user_id', userId)
    .single()

  if (!target) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  if (target.role === 'owner') {
    return NextResponse.json({ error: "Cannot change the owner's role" }, { status: 403 })
  }

  const { error } = await svc
    .from('org_members')
    .update({ role })
    .eq('org_id', membership.orgId)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE /api/members — remove a member from the org
export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = deleteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 })
  }

  const { orgSlug, userId } = parsed.data

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Regular members can only remove themselves (leave the org)
  if (membership.role === 'member' && userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const svc = createSupabaseServiceClient()
  const { data: target } = await svc
    .from('org_members')
    .select('role')
    .eq('org_id', membership.orgId)
    .eq('user_id', userId)
    .single()

  if (!target) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
  if (target.role === 'owner') {
    return NextResponse.json({ error: 'Cannot remove the org owner' }, { status: 403 })
  }
  if (target.role === 'admin' && membership.role !== 'owner') {
    return NextResponse.json({ error: 'Only owners can remove admins' }, { status: 403 })
  }

  const { error } = await svc
    .from('org_members')
    .delete()
    .eq('org_id', membership.orgId)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
