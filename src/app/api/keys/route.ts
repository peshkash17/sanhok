import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { generateApiKey } from '@/lib/api-key'
import { resolveOrgMembership } from '@/lib/auth'

// GET /api/keys?orgSlug=...  — list keys for an org (no key_hash returned)
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgSlug = request.nextUrl.searchParams.get('orgSlug')
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug is required' }, { status: 400 })

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const serviceClient = createSupabaseServiceClient()
  const { data, error } = await serviceClient
    .from('api_keys')
    .select('id, prefix, name, created_at, last_used_at, revoked_at')
    .eq('org_id', membership.orgId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

// POST /api/keys — create a new API key
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { orgSlug?: string; name?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { orgSlug, name } = body
  if (!orgSlug || !name) return NextResponse.json({ error: 'orgSlug and name are required' }, { status: 422 })

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Only admins and owners can create API keys.' }, { status: 403 })
  }

  const { rawKey, keyHash, prefix } = generateApiKey()
  const serviceClient = createSupabaseServiceClient()

  const { data, error } = await serviceClient
    .from('api_keys')
    .insert({ org_id: membership.orgId, key_hash: keyHash, prefix, name })
    .select('id, prefix, name, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // rawKey is returned ONCE — caller must store it; it is never retrievable again
  return NextResponse.json({ ...data, key: rawKey }, { status: 201 })
}

// DELETE /api/keys — revoke a key
export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { keyId?: string; orgSlug?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { keyId, orgSlug } = body
  if (!keyId || !orgSlug) return NextResponse.json({ error: 'keyId and orgSlug are required' }, { status: 422 })

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Only admins and owners can revoke API keys.' }, { status: 403 })
  }

  const serviceClient = createSupabaseServiceClient()
  const { error } = await serviceClient
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('org_id', membership.orgId)  // ensure org ownership

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
