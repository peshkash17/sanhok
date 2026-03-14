import { redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { EmptyState } from '@/components/ui/empty-state'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface Props {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ hours?: string }>
}

export default async function PerformancePage({ params, searchParams }: Props) {
  const { orgSlug } = await params
  const { hours = '24' } = await searchParams

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()
  const hoursInt = Math.min(168, Math.max(1, parseInt(hours, 10)))
  const since = new Date(Date.now() - hoursInt * 60 * 60 * 1000).toISOString()

  const { data: rows } = await svc
    .from('perf_aggregates_hourly')
    .select('operation, hour, p50, p90, p99, sample_count')
    .eq('org_id', orgId)
    .gte('hour', since)
    .order('hour', { ascending: true })

  const byOperation = (rows ?? []).reduce<Record<string, typeof rows>>((acc, row) => {
    if (!row) return acc
    const op = row.operation
    if (!acc[op]) acc[op] = []
    acc[op]!.push(row)
    return acc
  }, {})

  const operations = Object.keys(byOperation).sort()

  const latestPerOp = operations.map(op => {
    const opRows = byOperation[op]!
    const last = opRows[opRows.length - 1]!
    const prevP90 = opRows.length > 1 ? opRows[opRows.length - 2]?.p90 : null
    const trend = last.p90 != null && prevP90 != null
      ? last.p90 > prevP90 * 1.1 ? 'up' : last.p90 < prevP90 * 0.9 ? 'down' : 'flat'
      : 'flat'
    return { op, last, trend, totalSamples: opRows.reduce((s, r) => s + (r?.sample_count ?? 0), 0) }
  })

  const HOUR_OPTIONS = [
    { label: '1h', value: '1' },
    { label: '6h', value: '6' },
    { label: '24h', value: '24' },
    { label: '7d', value: '168' },
  ]

  const p90Color = (v: number | null) =>
    v == null ? '' : v > 1000 ? 'text-red-400' : v > 500 ? 'text-amber-400' : 'text-foreground'

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">Operation latency aggregated hourly</p>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden w-fit">
          {HOUR_OPTIONS.map(({ label, value }) => (
            <a
              key={value}
              href={`/${orgSlug}/performance?hours=${value}`}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                hours === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {label}
            </a>
          ))}
        </div>
      </div>

      {operations.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-7 w-7" />}
          title="No performance data yet"
          description="Send trace events via the ingestion API to see latency metrics here."
        />
      ) : (
        <>
          {/* Summary table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Latency summary — latest hour</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent bg-muted/30">
                      <TableHead>Operation</TableHead>
                      <TableHead className="text-right w-24">p50 (ms)</TableHead>
                      <TableHead className="text-right w-24">p90 (ms)</TableHead>
                      <TableHead className="text-right w-24">p99 (ms)</TableHead>
                      <TableHead className="text-right w-24 hidden sm:table-cell">Samples</TableHead>
                      <TableHead className="text-right w-16">Trend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {latestPerOp.map(({ op, last, trend, totalSamples }) => (
                      <TableRow key={op}>
                        <TableCell className="font-mono text-sm">{op}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {last.p50 != null ? last.p50.toFixed(0) : '—'}
                        </TableCell>
                        <TableCell className={cn('text-right tabular-nums font-medium', p90Color(last.p90))}>
                          {last.p90 != null ? last.p90.toFixed(0) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {last.p99 != null ? last.p99.toFixed(0) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                          {totalSamples}
                        </TableCell>
                        <TableCell className="text-right">
                          {trend === 'up' && <TrendingUp className="h-4 w-4 text-red-400 ml-auto" />}
                          {trend === 'down' && <TrendingDown className="h-4 w-4 text-emerald-400 ml-auto" />}
                          {trend === 'flat' && <Minus className="h-4 w-4 text-muted-foreground ml-auto" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Per-operation hourly breakdown */}
          {operations.map(op => {
            const opRows = byOperation[op]!
            return (
              <Card key={op}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono">{op}</CardTitle>
                    <Badge variant="muted">{opRows.length} data points</Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent bg-muted/20">
                          <TableHead>Hour</TableHead>
                          <TableHead className="text-right">p50</TableHead>
                          <TableHead className="text-right">p90</TableHead>
                          <TableHead className="text-right">p99</TableHead>
                          <TableHead className="text-right hidden sm:table-cell">n</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {opRows.slice(-12).reverse().map((row, i) => row && (
                          <TableRow key={i}>
                            <TableCell className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                              {new Date(row.hour).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                              {row.p50?.toFixed(0) ?? '—'}
                            </TableCell>
                            <TableCell className={cn('text-right text-xs tabular-nums font-medium', p90Color(row.p90))}>
                              {row.p90?.toFixed(0) ?? '—'}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                              {row.p99?.toFixed(0) ?? '—'}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground hidden sm:table-cell">
                              {row.sample_count}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </>
      )}
    </div>
  )
}
