'use client'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AccountPanel, ApiKeysPanel, MembersPanel, SetupGuidePanel } from './settings-panels'

interface OrgInfo {
  id: string
  name: string
  slug: string
  created_at: string
}

interface Member {
  user_id: string
  email?: string
  role: string
  joined_at: string
}

interface PendingInvitation {
  id: string
  email: string
  role: string
  expires_at: string
  created_at: string
}

interface ApiKey {
  id: string
  prefix: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

interface Props {
  orgSlug: string
  userEmail: string
  userRole: string
  org: OrgInfo | null
  keys: ApiKey[]
  members: Member[]
  currentUserId: string
  pendingInvitations: PendingInvitation[]
}

const TABS = [
  { id: 'account',      label: 'Account' },
  { id: 'organisation', label: 'Organisation' },
  { id: 'api',          label: 'API & SDK' },
] as const

export function SettingsTabs({
  orgSlug,
  userEmail,
  userRole,
  org,
  keys,
  members,
  currentUserId,
  pendingInvitations,
}: Props) {
  return (
    <Tabs defaultValue="account" className="space-y-6">
      <TabsList>
        {TABS.map(t => (
          <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>
        ))}
      </TabsList>

      {/* Account */}
      <TabsContent value="account" className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <AccountPanel userEmail={userEmail} />
        </div>
      </TabsContent>

      {/* Organisation */}
      <TabsContent value="organisation" className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Organisation details</h2>
          <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-sm">
            <span className="text-muted-foreground">Name</span>
            <span className="text-foreground">{org?.name ?? '—'}</span>
            <span className="text-muted-foreground">Slug</span>
            <span className="text-foreground font-mono">{org?.slug ?? '—'}</span>
            <span className="text-muted-foreground">Created</span>
            <span className="text-foreground">
              {org ? new Date(org.created_at).toLocaleDateString() : '—'}
            </span>
            <span className="text-muted-foreground">Your role</span>
            <span className="text-foreground capitalize">{userRole}</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <MembersPanel
            orgSlug={orgSlug}
            members={members}
            currentUserId={currentUserId}
            currentUserRole={userRole}
            pendingInvitations={pendingInvitations}
          />
        </div>
      </TabsContent>

      {/* API & SDK */}
      <TabsContent value="api" className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <ApiKeysPanel orgSlug={orgSlug} keys={keys} />
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          <SetupGuidePanel />
        </div>
      </TabsContent>
    </Tabs>
  )
}
