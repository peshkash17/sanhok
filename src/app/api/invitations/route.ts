import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { generateInvitationToken } from '@/lib/api-key'
import { resolveOrgMembership } from '@/lib/auth'

// POST /api/invitations — create and send an invitation
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { orgSlug?: string; email?: string; role?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { orgSlug, email, role } = body
  if (!orgSlug || !email || !role) {
    return NextResponse.json({ error: 'orgSlug, email, and role are required' }, { status: 422 })
  }

  if (!['admin', 'member'].includes(role)) {
    return NextResponse.json({ error: 'Role must be admin or member' }, { status: 422 })
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 422 })
  }

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Only admins and owners can invite members.' }, { status: 403 })
  }

  const { rawToken, tokenHash } = generateInvitationToken()
  const serviceClient = createSupabaseServiceClient()

  // Check for existing pending invitation
  const { data: existing } = await serviceClient
    .from('invitations')
    .select('id')
    .eq('org_id', membership.orgId)
    .eq('email', email.toLowerCase())
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (existing) {
    return NextResponse.json(
      { error: 'A pending invitation for this email already exists.' },
      { status: 409 }
    )
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days

  const { data: invitation, error } = await serviceClient
    .from('invitations')
    .insert({
      org_id: membership.orgId,
      email: email.toLowerCase(),
      role: role as 'admin' | 'member',
      token_hash: tokenHash,
      expires_at: expiresAt,
      invited_by: user.id,
    })
    .select('id, email, role, expires_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  const inviteUrl = `${siteUrl}/accept-invitation?token=${rawToken}`

  // Check if user already has an account — inviteUserByEmail only works for new users.
  // Existing users can use the invite URL directly (they'll be prompted to log in if needed).
  const { data: existingAuthUsers } = await serviceClient.auth.admin.listUsers({ perPage: 1000 })
  const userAlreadyExists = existingAuthUsers?.users.some(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  )

  let emailError: { message: string } | null = null

  if (!userAlreadyExists) {
    const callbackUrl = `${siteUrl}/accept-invitation?token=${rawToken}`
    const { error } = await serviceClient.auth.admin.inviteUserByEmail(
      email.toLowerCase(),
      { redirectTo: callbackUrl }
    )
    emailError = error
    if (emailError) {
      console.error('[Invitation] Email send failed:', emailError.message)
    }
  } else {
    console.log(`[Invitation] ${email} already has an account — skipping inviteUserByEmail`)
  }

  console.log(`[Invitation] ${email} → ${inviteUrl}`)

  return NextResponse.json(
    {
      invitation,
      invite_url: inviteUrl, // Dev convenience — use email transport in production
      email_sent: !emailError,
    },
    { status: 201 }
  )
}

// DELETE /api/invitations — cancel a pending invitation
export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { invitationId?: string; orgSlug?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { invitationId, orgSlug } = body
  if (!invitationId || !orgSlug) {
    return NextResponse.json({ error: 'invitationId and orgSlug are required' }, { status: 422 })
  }

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Only admins and owners can cancel invitations' }, { status: 403 })
  }

  const serviceClient = createSupabaseServiceClient()
  const { error } = await serviceClient
    .from('invitations')
    .delete()
    .eq('id', invitationId)
    .eq('org_id', membership.orgId)
    .is('accepted_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// GET /api/invitations?orgSlug=... — list pending invitations
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgSlug = request.nextUrl.searchParams.get('orgSlug')
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug is required' }, { status: 400 })

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createSupabaseServiceClient()
  const { data, error } = await serviceClient
    .from('invitations')
    .select('id, email, role, expires_at, accepted_at, created_at')
    .eq('org_id', membership.orgId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}
