import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatRelativeTime, formatNumber } from '@/lib/utils'
import { Users, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ page?: string; identified?: string }>
}

const PAGE_SIZE = 25

export default async function SessionsPage({ params, searchParams }: Props) {
  const { orgSlug } = await params
  const { page = '1', identified = '' } = await searchParams

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()
  const pageNum = Math.max(1, parseInt(page, 10))
  const from = (pageNum - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  let query = svc
    .from('sessions')
    .select('id, session_id, anonymous_id, user_id, started_at, ended_at, duration_seconds', { count: 'exact' })
    .eq('org_id', orgId)
    .order('started_at', { ascending: false })
    .range(from, to)

  if (identified === '1') query = query.not('user_id', 'is', null)
  if (identified === '0') query = query.is('user_id', null)

  const { data: sessions, count } = await query

  const sessionIds = (sessions ?? []).map(s => s.session_id)
  const { data: eventCounts } = sessionIds.length > 0
    ? await svc.from('session_events').select('session_id').eq('org_id', orgId).in('session_id', sessionIds)
    : { data: [] }

  const countBySid = (eventCounts ?? []).reduce<Record<string, number>>((acc, e) => {
    acc[e.session_id] = (acc[e.session_id] ?? 0) + 1
    return acc
  }, {})

  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE)

  const buildUrl = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({ page, identified, ...overrides })
    return `/${orgSlug}/sessions?${p.toString()}`
  }

  const formatDuration = (secs: number | null) => {
    if (!secs) return '—'
    if (secs < 60) return `${secs}s`
    return `${Math.floor(secs / 60)}m ${secs % 60}s`
  }

  const FILTERS = [
    { label: 'All', value: '' },
    { label: 'Identified', value: '1' },
    { label: 'Anonymous', value: '0' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {count != null ? `${formatNumber(count)} session${count !== 1 ? 's' : ''}` : 'Loading...'}
        </p>
      </div>

      {/* Filters */}
      <div className="flex rounded-lg border border-border overflow-hidden w-fit">
        {FILTERS.map(({ label, value }) => (
          <Link
            key={value}
            href={buildUrl({ identified: value, page: '1' })}
            className={cn(
              'px-3 py-1.5 text-sm transition-colors',
              identified === value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {!sessions || sessions.length === 0 ? (
        <EmptyState
          icon={<Users className="h-7 w-7" />}
          title="No sessions yet"
          description="Sessions are recorded when users interact with your app via the ingestion API."
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent bg-muted/30">
                <TableHead>Session ID</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right w-20">Events</TableHead>
                <TableHead className="text-right w-24 hidden sm:table-cell">Duration</TableHead>
                <TableHead className="text-right w-36">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link
                      href={`/${orgSlug}/sessions/${s.id}`}
                      className="font-mono text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      {s.session_id.slice(0, 16)}...
                    </Link>
                  </TableCell>
                  <TableCell>
                    {s.user_id ? (
                      <Badge variant="info">{s.user_id.slice(0, 12)}...</Badge>
                    ) : (
                      <Badge variant="muted">anonymous</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {countBySid[s.session_id] ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                    {formatDuration(s.duration_seconds)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatRelativeTime(s.started_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {pageNum} of {totalPages}</span>
          <div className="flex gap-2">
            {pageNum > 1 && (
              <Button variant="outline" size="sm" render={<Link href={buildUrl({ page: String(pageNum - 1) })} />}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
            )}
            {pageNum < totalPages && (
              <Button variant="outline" size="sm" render={<Link href={buildUrl({ page: String(pageNum + 1) })} />}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
