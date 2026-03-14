import { redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { SettingsTabs } from './settings-tabs'

interface Props {
  params: Promise<{ orgSlug: string }>
}

export default async function SettingsPage({ params }: Props) {
  const { orgSlug } = await params

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  const [{ data: keys }, { data: members }, { data: org }, { data: invitations }] = await Promise.all([
    svc.from('api_keys')
      .select('id, prefix, name, created_at, last_used_at, revoked_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false }),

    svc.from('org_members')
      .select('user_id, role, joined_at')
      .eq('org_id', orgId)
      .order('joined_at', { ascending: true }),

    svc.from('organisations')
      .select('id, name, slug, created_at')
      .eq('id', orgId)
      .single(),

    svc.from('invitations')
      .select('id, email, role, expires_at, created_at')
      .eq('org_id', orgId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }),
  ])

  // Enrich members with their email addresses via the admin API
  const emailMap: Record<string, string> = {}
  if ((members ?? []).length > 0) {
    const { data: authData } = await svc.auth.admin.listUsers({ perPage: 1000 })
    const memberSet = new Set((members ?? []).map(m => m.user_id))
    ;(authData?.users ?? []).forEach((u: { id: string; email?: string }) => {
      if (memberSet.has(u.id) && u.email) emailMap[u.id] = u.email
    })
  }

  const enrichedMembers = (members ?? []).map(m => ({ ...m, email: emailMap[m.user_id] }))

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        {org && (
          <p className="mt-1 text-sm text-muted-foreground">
            {org.name} · <span className="font-mono text-muted-foreground/60">{org.slug}</span>
          </p>
        )}
      </div>

      <SettingsTabs
        orgSlug={orgSlug}
        userEmail={user.email ?? ''}
        userRole={membership.role}
        org={org ?? null}
        keys={keys ?? []}
        members={enrichedMembers}
        currentUserId={user.id}
        pendingInvitations={invitations ?? []}
      />
    </div>
  )
}
