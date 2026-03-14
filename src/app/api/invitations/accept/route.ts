import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { hashToken } from '@/lib/api-key'

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Must be signed in to accept an invitation.' }, { status: 401 })

  let body: { token?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { token } = body
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 422 })

  const tokenHash = hashToken(token)
  const serviceClient = createSupabaseServiceClient()

  const { data: result, error } = await serviceClient.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const res = result as unknown as { success: boolean; error?: string; org_id?: string } | null
  if (!res?.success) return NextResponse.json({ error: res?.error ?? 'Failed to accept invitation' }, { status: 400 })

  // Get the org slug to redirect the user
  const { data: org } = await serviceClient
    .from('organisations')
    .select('slug')
    .eq('id', res.org_id!)
    .single()

  return NextResponse.json({ success: true, org_slug: org?.slug })
}
