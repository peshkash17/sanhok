'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Copy, Check } from 'lucide-react'

// ---------------------------------------------------------------------------

export function AccountPanel({ userEmail }: { userEmail: string }) {
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendReset() {
    setLoading(true)
    setError(null)
    const supabase = createSupabaseBrowserClient()
    const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Account</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Signed in as <span className="text-foreground font-medium">{userEmail}</span></p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-foreground">Password</p>
          <p className="text-xs text-muted-foreground">Send a reset link to your email address.</p>
        </div>
        {sent ? (
          <p className="text-sm text-emerald-500">Reset link sent!</p>
        ) : (
          <Button variant="outline" size="sm" onClick={sendReset} disabled={loading}>
            {loading ? 'Sending…' : 'Reset password'}
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

interface ApiKey {
  id: string
  prefix: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

interface ApiKeysPanelProps {
  orgSlug: string
  keys: ApiKey[]
}

export function ApiKeysPanel({ orgSlug, keys: initialKeys }: ApiKeysPanelProps) {
  const [keys, setKeys] = useState(initialKeys)
  const [newKeyName, setNewKeyName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newRawKey, setNewRawKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createKey = async () => {
    if (!newKeyName.trim()) return
    setCreating(true)
    setError(null)
    setNewRawKey(null)
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newKeyName.trim(), orgSlug }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setCreating(false); return }
    setNewRawKey(data.key)
    // API returns the flat object: { id, prefix, name, created_at, key }
    setKeys(k => [{ id: data.id, prefix: data.prefix, name: data.name, created_at: data.created_at, last_used_at: null, revoked_at: null }, ...k])
    setNewKeyName('')
    setCreating(false)
  }

  const revokeKey = async (id: string) => {
    const res = await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyId: id, orgSlug }),
    })
    if (res.ok) setKeys(k => k.map(key => key.id === id ? { ...key, revoked_at: new Date().toISOString() } : key))
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">API Keys</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Use these keys to send events to the ingestion API. Keys are shown once — store them securely.</p>
      </div>

      <div className="flex gap-3">
        <Input
          placeholder="Key name (e.g. production)"
          value={newKeyName}
          onChange={e => setNewKeyName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createKey()}
          className="flex-1"
        />
        <Button onClick={createKey} disabled={creating || !newKeyName.trim()}>
          {creating ? 'Creating...' : 'Create key'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {newRawKey && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-950/20 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">New API key — copy it now, it won&apos;t be shown again</p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(newRawKey)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-200 transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-sm text-emerald-800 dark:text-emerald-300 break-all select-all font-mono">{newRawKey}</code>
        </div>
      )}

      <div className="rounded-lg border border-border divide-y divide-border">
        {keys.length === 0 && (
          <p className="px-4 py-6 text-sm text-center text-muted-foreground">No API keys yet</p>
        )}
        {keys.map(key => (
          <div key={key.id} className="flex items-center justify-between px-4 py-3 gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-foreground font-medium">{key.name}</p>
                {key.revoked_at && <Badge variant="muted">Revoked</Badge>}
              </div>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">{key.prefix}...</p>
              {key.last_used_at && (
                <p className="text-xs text-muted-foreground/60 mt-0.5">Last used {new Date(key.last_used_at).toLocaleDateString()}</p>
              )}
            </div>
            {!key.revoked_at && (
              <Button variant="destructive" size="sm" onClick={() => revokeKey(key.id)}>Revoke</Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

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

interface MembersPanelProps {
  orgSlug: string
  members: Member[]
  currentUserId: string
  currentUserRole: string
  pendingInvitations: PendingInvitation[]
}

export function MembersPanel({
  orgSlug,
  members,
  currentUserId,
  currentUserRole,
  pendingInvitations: initialInvitations,
}: MembersPanelProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [invitations, setInvitations] = useState(initialInvitations)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  void setInvitations // used in cancelInvitation/sendInvite
  const [sending, setSending] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState<boolean | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const canManage = currentUserRole === 'owner' || currentUserRole === 'admin'

  const refresh = () => startTransition(() => router.refresh())

  const changeRole = async (userId: string, newRole: 'admin' | 'member') => {
    setActionError(null)
    const res = await fetch('/api/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug, userId, role: newRole }),
    })
    const data = await res.json()
    if (!res.ok) { setActionError(data.error); return }
    refresh()
  }

  const removeMember = async (userId: string, isLeaving: boolean) => {
    const msg = isLeaving
      ? 'Are you sure you want to leave this organisation?'
      : 'Remove this member from the organisation?'
    if (!confirm(msg)) return
    setActionError(null)
    const res = await fetch('/api/members', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug, userId }),
    })
    const data = await res.json()
    if (!res.ok) { setActionError(data.error); return }
    if (isLeaving) {
      router.push('/')
    } else {
      refresh()
    }
  }

  const cancelInvitation = async (invitationId: string) => {
    if (!confirm('Cancel this invitation?')) return
    const res = await fetch('/api/invitations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitationId, orgSlug }),
    })
    if (res.ok) {
      setInvitations(prev => prev.filter(i => i.id !== invitationId))
    }
  }

  const sendInvite = async () => {
    if (!email.trim()) return
    setSending(true)
    setInviteError(null)
    setInviteUrl(null)
    const res = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), role, orgSlug }),
    })
    const data = await res.json()
    if (!res.ok) { setInviteError(data.error); setSending(false); return }
    setInviteUrl(data.invite_url ?? null)
    setEmailSent(data.email_sent ?? false)
    if (data.invitation) {
      setInvitations(prev => [data.invitation, ...prev])
    }
    setEmail('')
    setSending(false)
  }

  return (
    <div className="space-y-5">
      <h2 className="text-sm font-semibold text-foreground">Members</h2>

      {actionError && (
        <p className="text-sm text-destructive rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2">{actionError}</p>
      )}

      {/* Members list */}
      <div className="rounded-lg border border-border divide-y divide-border">
        {members.map(m => {
          const isCurrentUser = m.user_id === currentUserId
          const isOwner = m.role === 'owner'
          const canChangeThisRole = canManage && !isCurrentUser && !isOwner
          const canRemoveThis =
            (isCurrentUser && !isOwner) ||
            (canManage && !isOwner && (currentUserRole === 'owner' || m.role === 'member'))

          return (
            <div key={m.user_id} className="flex items-center justify-between px-4 py-3 gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-sm">
                    {(m.email ?? m.user_id)[0].toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    {m.email ?? <span className="font-mono text-muted-foreground text-xs">{m.user_id}</span>}
                    {isCurrentUser && <span className="ml-2 text-xs text-muted-foreground/60">(you)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground/60">Joined {new Date(m.joined_at).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {canChangeThisRole ? (
                  <select
                    value={m.role}
                    onChange={e => changeRole(m.user_id, e.target.value as 'admin' | 'member')}
                    className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className="text-xs text-muted-foreground capitalize">{m.role}</span>
                )}
                {canRemoveThis && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => removeMember(m.user_id, isCurrentUser)}
                  >
                    {isCurrentUser ? 'Leave' : 'Remove'}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Pending invitations */}
      {canManage && invitations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Pending invitations</h3>
          <div className="rounded-lg border border-border divide-y divide-border">
            {invitations.map(inv => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3 gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                    {inv.role} · Expires {new Date(inv.expires_at).toLocaleDateString()}
                  </p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => cancelInvitation(inv.id)}>Cancel</Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invite form */}
      {canManage && (
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Invite someone</h3>
          <div className="flex gap-3 flex-wrap">
            <Input
              placeholder="Email address"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendInvite()}
              className="flex-1 min-w-50"
            />
            <select
              value={role}
              onChange={e => setRole(e.target.value as 'admin' | 'member')}
              className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button onClick={sendInvite} disabled={sending || !email.trim()}>
              {sending ? 'Sending...' : 'Send invite'}
            </Button>
          </div>
          {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
          {inviteUrl && (
            <div className="space-y-2">
              {emailSent === true && (
                <p className="text-sm text-emerald-400">✓ Invite email sent successfully.</p>
              )}
              {emailSent === false && (
                <p className="text-sm text-amber-400">
                  Email not delivered — no SMTP configured. Set <code className="font-mono text-xs">SMTP_HOST/SMTP_USER/SMTP_PASS</code> (e.g. Brevo) or a verified Resend domain. Share the link below in the meantime.
                </p>
              )}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-xs text-primary">Invite link — valid for 7 days</p>
                  <button
                    onClick={() => navigator.clipboard.writeText(inviteUrl)}
                    className="text-xs text-primary/70 hover:text-primary transition-colors px-2 py-0.5 rounded border border-primary/20 hover:border-primary/40"
                  >
                    Copy
                  </button>
                </div>
                <code className="text-xs text-primary/80 break-all font-mono">{inviteUrl}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function SetupGuidePanel() {
  const [tab, setTab] = useState<'error' | 'activity' | 'trace'>('error')
  const [lang, setLang] = useState<'curl' | 'js'>('js')
  const [snippetCopied, setSnippetCopied] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const [origin, setOrigin] = useState('https://your-domain.com')

  useEffect(() => { setOrigin(window.location.origin) }, [])

  const endpoint = `${origin}/api/ingest`
  const KEY = 'YOUR_API_KEY'

  type EventTab = 'error' | 'activity' | 'trace'
  type LangTab = 'curl' | 'js'

  const snippets: Record<EventTab, Record<LangTab, string>> = {
    error: {
      js: [
        `// Global error handler (browser)`,
        `window.addEventListener('error', async (e) => {`,
        `  await fetch('${origin}/api/ingest', {`,
        `    method: 'POST',`,
        `    headers: {`,
        `      'Authorization': 'Bearer ${KEY}',`,
        `      'Content-Type': 'application/json',`,
        `    },`,
        `    body: JSON.stringify({`,
        `      idempotency_key: crypto.randomUUID(),`,
        `      events: [{`,
        `        type: 'error',`,
        `        message: e.message,`,
        `        exception_type: e.error?.name ?? 'Error',`,
        `        stack_trace: parseStack(e.error?.stack), // [{file, function, lineno}]`,
        `        environment: 'production',`,
        `        release: '1.0.0',         // optional`,
        `        user_id: currentUserId,   // optional`,
        `        occurred_at: new Date().toISOString(),`,
        `      }],`,
        `    }),`,
        `  })`,
        `})`,
      ].join('\n'),
      curl: [
        `curl -X POST ${origin}/api/ingest \\`,
        `  -H "Authorization: Bearer ${KEY}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `  "idempotency_key": "err-001",`,
        `  "events": [{`,
        `    "type": "error",`,
        `    "message": "Cannot read properties of undefined",`,
        `    "exception_type": "TypeError",`,
        `    "environment": "production",`,
        `    "stack_trace": [`,
        `      {"file": "src/app.js", "function": "handleClick", "lineno": 42}`,
        `    ],`,
        `    "occurred_at": "2026-03-14T12:00:00.000Z"`,
        `  }]`,
        `}'`,
      ].join('\n'),
    },
    activity: {
      js: [
        `// Track a page view`,
        `await fetch('${origin}/api/ingest', {`,
        `  method: 'POST',`,
        `  headers: {`,
        `    'Authorization': 'Bearer ${KEY}',`,
        `    'Content-Type': 'application/json',`,
        `  },`,
        `  body: JSON.stringify({`,
        `    idempotency_key: crypto.randomUUID(),`,
        `    events: [{`,
        `      type: 'activity',`,
        `      session_id: getSessionId(),     // stable per browser session`,
        `      anonymous_id: getAnonymousId(), // stable per device`,
        `      event_type: 'page_view',        // page_view | click | custom | identify`,
        `      event_name: 'Page Viewed',`,
        `      url: window.location.href,`,
        `      referrer: document.referrer || undefined,`,
        `      occurred_at: new Date().toISOString(),`,
        `    }],`,
        `  }),`,
        `})`,
        ``,
        `// Link anonymous → identified user (triggers retroactive stitching):`,
        `// event_type: 'identify', user_id: 'user_123'`,
      ].join('\n'),
      curl: [
        `curl -X POST ${origin}/api/ingest \\`,
        `  -H "Authorization: Bearer ${KEY}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `  "idempotency_key": "sess-001",`,
        `  "events": [{`,
        `    "type": "activity",`,
        `    "session_id": "sess_abc123",`,
        `    "anonymous_id": "anon_xyz789",`,
        `    "event_type": "page_view",`,
        `    "event_name": "Page Viewed",`,
        `    "url": "https://example.com/dashboard",`,
        `    "occurred_at": "2026-03-14T12:00:00.000Z"`,
        `  }]`,
        `}'`,
      ].join('\n'),
    },
    trace: {
      js: [
        `// Instrument a slow operation`,
        `const traceId = crypto.randomUUID()`,
        `const startedAt = new Date()`,
        ``,
        `await expensiveOperation()  // the thing you want to measure`,
        ``,
        `const endedAt = new Date()`,
        `await fetch('${origin}/api/ingest', {`,
        `  method: 'POST',`,
        `  headers: {`,
        `    'Authorization': 'Bearer ${KEY}',`,
        `    'Content-Type': 'application/json',`,
        `  },`,
        `  body: JSON.stringify({`,
        `    idempotency_key: crypto.randomUUID(),`,
        `    events: [{`,
        `      type: 'trace',`,
        `      trace_id: traceId,`,
        `      span_id: crypto.randomUUID(),`,
        `      operation: 'db.query.getUser',   // shown in Performance tab`,
        `      duration_ms: endedAt.getTime() - startedAt.getTime(),`,
        `      status: 'ok',                    // ok | error | timeout`,
        `      started_at: startedAt.toISOString(),`,
        `      ended_at: endedAt.toISOString(),`,
        `      tags: { db: 'postgres', table: 'users' },`,
        `    }],`,
        `  }),`,
        `})`,
        `// Aggregated p50/p90/p99 appear in Performance after ~5 minutes`,
      ].join('\n'),
      curl: [
        `curl -X POST ${origin}/api/ingest \\`,
        `  -H "Authorization: Bearer ${KEY}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{`,
        `  "idempotency_key": "trace-001",`,
        `  "events": [{`,
        `    "type": "trace",`,
        `    "trace_id": "trace-abc123",`,
        `    "span_id": "span-def456",`,
        `    "operation": "db.query.getUser",`,
        `    "duration_ms": 142,`,
        `    "status": "ok",`,
        `    "started_at": "2026-03-14T12:00:00.000Z",`,
        `    "ended_at":   "2026-03-14T12:00:00.142Z"`,
        `  }]`,
        `}'`,
      ].join('\n'),
    },
  }

  const snippet = snippets[tab][lang]
  const tabLabel: Record<EventTab, string> = { error: 'Errors', activity: 'Sessions', trace: 'Performance' }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">SDK &amp; Integration</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Send events to the HTTP API from any language or framework. Authenticate with{' '}
          <code className="font-mono text-xs">Bearer YOUR_API_KEY</code> using a key from above.
        </p>
      </div>

      {/* Endpoint URL */}
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <span className="text-xs font-mono text-muted-foreground shrink-0">POST</span>
        <code className="flex-1 text-xs text-foreground font-mono truncate">{endpoint}</code>
        <button
          onClick={() => { navigator.clipboard.writeText(endpoint); setUrlCopied(true); setTimeout(() => setUrlCopied(false), 2000) }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          {urlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {urlCopied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Tab row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
          {(['error', 'activity', 'trace'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 transition-colors ${
                tab === t
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {tabLabel[t]}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
          {(['js', 'curl'] as const).map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-3 py-1.5 transition-colors ${
                lang === l
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {l === 'js' ? 'JavaScript' : 'cURL'}
            </button>
          ))}
        </div>
      </div>

      {/* Code block */}
      <div className="relative rounded-lg bg-muted/60 border border-border">
        <button
          onClick={() => { navigator.clipboard.writeText(snippet); setSnippetCopied(true); setTimeout(() => setSnippetCopied(false), 2000) }}
          className="absolute top-3 right-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          {snippetCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {snippetCopied ? 'Copied!' : 'Copy'}
        </button>
        <pre className="overflow-x-auto p-4 pr-20 text-xs font-mono text-foreground leading-relaxed">
          <code>{snippet}</code>
        </pre>
      </div>

      {/* Notes */}
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Batching:</span>{' '}
          Include up to <span className="font-mono">100</span> events per request in the{' '}
          <span className="font-mono">events</span> array. Retry with the same{' '}
          <span className="font-mono">idempotency_key</span> safely — duplicates are ignored.
        </p>
        <p>
          <span className="font-medium text-foreground">Processing:</span>{' '}
          Events queue and drain every 10 s. Error groups appear in{' '}
          <span className="font-medium text-foreground">Errors</span> almost immediately;
          performance aggregates appear in{' '}
          <span className="font-medium text-foreground">Performance</span> within 5 minutes.
        </p>
        <p>
          <span className="font-medium text-foreground">Rate limit:</span>{' '}
          1 000 events / minute per org (token-bucket). Responses include{' '}
          <span className="font-mono">X-RateLimit-Remaining</span>; a{' '}
          <span className="font-mono">429</span> carries <span className="font-mono">Retry-After</span>.
        </p>
      </div>
    </div>
  )
}
