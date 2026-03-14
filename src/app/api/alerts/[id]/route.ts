import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { z } from 'zod'

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  resolved: z.boolean(),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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

  const { orgSlug, resolved } = parsed.data
  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const svc = createSupabaseServiceClient()

  const { error } = await svc
    .from('alerts')
    .update({ resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('org_id', membership.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ resolved })
}
