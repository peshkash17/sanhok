import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { formatRelativeTime, formatNumber } from '@/lib/utils'
import { Bug, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ status?: string; q?: string; page?: string }>
}

const STATUS_OPTIONS = ['open', 'resolved', 'ignored', 'regressed'] as const
type Status = (typeof STATUS_OPTIONS)[number]

function statusVariant(status: string): 'error' | 'success' | 'muted' | 'warning' {
  if (status === 'open') return 'error'
  if (status === 'regressed') return 'warning'
  if (status === 'resolved') return 'success'
  return 'muted'
}

const PAGE_SIZE = 25

export default async function ErrorsPage({ params, searchParams }: Props) {
  const { orgSlug } = await params
  const { status = 'open', q = '', page = '1' } = await searchParams

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
    .from('error_groups')
    .select('id, title, culprit, status, occurrence_count, user_count, last_seen, first_seen', { count: 'exact' })
    .eq('org_id', orgId)
    .order('last_seen', { ascending: false })
    .range(from, to)

  if (STATUS_OPTIONS.includes(status as Status)) {
    query = query.eq('status', status as 'open' | 'resolved' | 'regressed' | 'ignored')
  }
  if (q.trim()) {
    query = query.ilike('title', `%${q.trim()}%`)
  }

  const { data: errors, count } = await query
  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE)

  const buildUrl = (overrides: Record<string, string>) => {
    const p = new URLSearchParams({ status, q, page, ...overrides })
    return `/${orgSlug}/errors?${p.toString()}`
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Errors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {count != null ? `${formatNumber(count)} issue${count !== 1 ? 's' : ''}` : 'Loading...'}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status tabs */}
        <div className="flex rounded-lg border border-border overflow-hidden">
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s}
              href={buildUrl({ status: s, page: '1' })}
              className={cn(
                'px-3 py-1.5 text-sm capitalize transition-colors',
                status === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {s}
            </Link>
          ))}
        </div>

        {/* Search */}
        <form method="GET" action={`/${orgSlug}/errors`} className="flex-1 min-w-45">
          <input type="hidden" name="status" value={status} />
          <input type="hidden" name="page" value="1" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search errors..."
            className="h-8 text-sm"
          />
        </form>
      </div>

      {/* Table */}
      {!errors || errors.length === 0 ? (
        <EmptyState
          icon={<Bug className="h-7 w-7" />}
          title={status === 'open' ? 'No errors — your app is clean' : `No ${status} errors`}
          description={status === 'open' ? 'When errors are reported they will appear here.' : undefined}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent bg-muted/30">
                <TableHead>Error</TableHead>
                <TableHead className="text-right w-24">Events</TableHead>
                <TableHead className="text-right w-24 hidden sm:table-cell">Users</TableHead>
                <TableHead className="text-right w-36">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.map((err) => (
                <TableRow key={err.id}>
                  <TableCell>
                    <div className="flex items-start gap-3">
                      <Badge variant={statusVariant(err.status)} className="mt-0.5 shrink-0">
                        {err.status}
                      </Badge>
                      <div className="min-w-0">
                        <Link
                          href={`/${orgSlug}/errors/${err.id}`}
                          className="font-mono text-sm text-foreground hover:text-primary transition-colors line-clamp-1 block"
                        >
                          {err.title}
                        </Link>
                        {err.culprit && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono">{err.culprit}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatNumber(err.occurrence_count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                    {formatNumber(err.user_count)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                    {formatRelativeTime(err.last_seen)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
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
