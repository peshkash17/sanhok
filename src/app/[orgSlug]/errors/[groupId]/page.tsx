import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { formatRelativeTime, formatNumber } from '@/lib/utils'
import { ErrorActions } from './error-actions'
import { Sparkles, ChevronRight } from 'lucide-react'

interface Props {
  params: Promise<{ orgSlug: string; groupId: string }>
}

type Frame = {
  filename?: string
  function?: string
  lineno?: number
  colno?: number
  in_app?: boolean
  context_line?: string
}

function statusVariant(status: string): 'error' | 'success' | 'muted' | 'warning' {
  if (status === 'open') return 'error'
  if (status === 'regressed') return 'warning'
  if (status === 'resolved') return 'success'
  return 'muted'
}

export default async function ErrorDetailPage({ params }: Props) {
  const { orgSlug, groupId } = await params

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  const [
    { data: group },
    { data: occurrences },
    { data: affectedUsers },
    { data: relatedAlert },
  ] = await Promise.all([
    svc.from('error_groups').select('*').eq('org_id', orgId).eq('id', groupId).single(),
    svc.from('error_occurrences')
      .select('id, message, exception_type, stack_trace, user_id, user_email, tags, request_url, request_method, occurred_at, environment, release')
      .eq('org_id', orgId).eq('group_id', groupId)
      .order('occurred_at', { ascending: false }).limit(50),
    svc.from('error_occurrences')
      .select('user_email, user_id')
      .eq('org_id', orgId).eq('group_id', groupId)
      .not('user_email', 'is', null)
      .order('occurred_at', { ascending: false }).limit(10),
    svc.from('alerts')
      .select('id, type, metric_value, baseline_value, deviation_percent, started_at, ai_explanation')
      .eq('org_id', orgId).eq('type', 'error_spike').is('resolved_at', null)
      .order('started_at', { ascending: false }).limit(1),
  ])

  if (!group) notFound()

  const latestOccurrence = occurrences?.[0]
  const stackFrames: Frame[] = (() => {
    const raw = latestOccurrence?.stack_trace
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const frames = (raw as Record<string, unknown>).frames
    return Array.isArray(frames) ? (frames as Frame[]) : []
  })()

  const uniqueUsers = Array.from(
    new Map((affectedUsers ?? []).map(u => [u.user_email ?? u.user_id, u])).values()
  )

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href={`/${orgSlug}/errors`} className="hover:text-foreground transition-colors">Errors</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground font-mono truncate max-w-50 sm:max-w-xs">{group.title}</span>
      </nav>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Badge variant={statusVariant(group.status)}>{group.status}</Badge>
            {group.status === 'regressed' && <Badge variant="warning">Regression</Badge>}
            {relatedAlert?.[0] && <Badge variant="error">Active spike</Badge>}
          </div>
          <h1 className="text-xl font-bold font-mono text-foreground break-all">{group.title}</h1>
          {group.culprit && (
            <p className="mt-1 text-sm font-mono text-muted-foreground">{group.culprit}</p>
          )}
        </div>
        <ErrorActions groupId={groupId} orgSlug={orgSlug} currentStatus={group.status} />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total events', value: formatNumber(group.occurrence_count) },
          { label: 'Affected users', value: formatNumber(group.user_count) },
          { label: 'First seen', value: formatRelativeTime(group.first_seen) },
          { label: 'Last seen', value: formatRelativeTime(group.last_seen) },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1.5 text-lg font-semibold text-foreground tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* AI explanation */}
      {relatedAlert?.[0]?.ai_explanation && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <p className="text-xs font-semibold text-primary">AI Analysis</p>
            </div>
            <p className="text-sm text-foreground/80 leading-relaxed">{relatedAlert[0].ai_explanation}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Stack trace + occurrences — 2/3 */}
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Stack trace</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {stackFrames.length > 0 ? (
                <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                  {[...stackFrames].reverse().map((frame, i) => (
                    <div
                      key={i}
                      className={`px-4 py-3 font-mono text-xs ${frame.in_app ? 'bg-muted/20' : 'opacity-50'}`}
                    >
                      <p className={frame.in_app ? 'text-primary' : 'text-muted-foreground'}>
                        {frame.function ?? '<anonymous>'}
                      </p>
                      <p className="text-muted-foreground/70 mt-0.5">
                        {frame.filename ?? ''}{frame.lineno != null ? `:${frame.lineno}` : ''}{frame.colno != null ? `:${frame.colno}` : ''}
                      </p>
                      {frame.context_line && (
                        <p className="mt-1.5 text-amber-400/80 bg-muted/30 px-2 py-1 rounded text-xs whitespace-pre-wrap">
                          {frame.context_line.trim()}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">No stack trace available</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Recent occurrences</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent bg-muted/20">
                      <TableHead>When</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead className="hidden sm:table-cell">Env</TableHead>
                      <TableHead className="hidden sm:table-cell">Release</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(occurrences ?? []).slice(0, 20).map((occ) => (
                      <TableRow key={occ.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatRelativeTime(occ.occurred_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-35">
                          {occ.user_email ?? occ.user_id ?? <span className="text-muted-foreground/40">anonymous</span>}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {occ.environment && <Badge variant="muted">{occ.environment}</Badge>}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs font-mono text-muted-foreground/70">
                          {occ.release ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar — 1/3 */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Affected users</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {uniqueUsers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No identified users</p>
              ) : (
                <ul className="space-y-2">
                  {uniqueUsers.map((u) => (
                    <li key={u.user_email ?? u.user_id} className="flex items-center gap-2.5">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-[10px]">
                          {(u.user_email ?? '?')[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs text-muted-foreground truncate">{u.user_email ?? u.user_id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {latestOccurrence?.request_url && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Request</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {latestOccurrence.request_method && (
                  <Badge variant="info">{latestOccurrence.request_method}</Badge>
                )}
                <p className="text-xs text-muted-foreground font-mono break-all">{latestOccurrence.request_url}</p>
              </CardContent>
            </Card>
          )}

          {latestOccurrence?.tags && typeof latestOccurrence.tags === 'object' && !Array.isArray(latestOccurrence.tags) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Tags</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(latestOccurrence.tags as Record<string, unknown>).map(([k, v]) => (
                    <span key={k} className="text-xs bg-muted rounded px-2 py-1 text-muted-foreground">
                      <span className="text-muted-foreground/60">{k}:</span> {String(v)}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
