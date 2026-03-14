import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { slugify } from '@/lib/utils'

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { name?: string; slug?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, slug } = body

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return NextResponse.json({ error: 'Organisation name must be at least 2 characters.' }, { status: 422 })
  }

  const finalSlug = slug ? slugify(slug) : slugify(name)
  if (!finalSlug || finalSlug.length < 2) {
    return NextResponse.json({ error: 'Invalid slug. Use lowercase letters, numbers, and hyphens.' }, { status: 422 })
  }

  const serviceClient = createSupabaseServiceClient()

  // Check slug uniqueness before calling the function
  const { data: existing } = await serviceClient
    .from('organisations')
    .select('id')
    .eq('slug', finalSlug)
    .single()

  if (existing) {
    return NextResponse.json({ error: 'An organisation with this slug already exists.' }, { status: 409 })
  }

  const { data: orgId, error } = await serviceClient.rpc('create_org_with_owner', {
    p_user_id: user.id,
    p_org_name: name.trim(),
    p_org_slug: finalSlug,
  })

  if (error) {
    console.error('[POST /api/orgs]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ id: orgId, slug: finalSlug }, { status: 201 })
}
