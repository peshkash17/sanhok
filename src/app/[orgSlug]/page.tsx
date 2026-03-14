import { redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime, formatNumber } from '@/lib/utils'
import Link from 'next/link'
import { AlertTriangle, Bell, Users, Zap, TrendingUp, TrendingDown, ArrowRight } from 'lucide-react'

interface Props {
  params: Promise<{ orgSlug: string }>
}

export default async function OrgOverviewPage({ params }: Props) {
  const { orgSlug } = await params
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  const [
    { count: openErrors },
    { data: recentAlerts },
    { data: topErrors },
    { count: activeSessions },
    { data: latencySnapshot },
  ] = await Promise.all([
    svc.from('error_groups').select('*', { count: 'exact', head: true })
      .eq('org_id', orgId).eq('status', 'open'),
    svc.from('alerts').select('id, type, metric_value, baseline_value, deviation_percent, started_at, ai_explanation')
      .eq('org_id', orgId).is('resolved_at', null)
      .order('started_at', { ascending: false }).limit(5),
    svc.from('error_groups')
      .select('id, title, culprit, status, occurrence_count, last_seen')
      .eq('org_id', orgId).eq('status', 'open')
      .order('last_seen', { ascending: false }).limit(5),
    svc.from('sessions').select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('started_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    svc.from('perf_aggregates_hourly')
      .select('operation, p99, hour')
      .eq('org_id', orgId)
      .order('hour', { ascending: false })
      .limit(10),
  ])

  const alertTypeLabel: Record<string, string> = {
    error_spike:      'Error spike',
    latency_drift:    'Latency drift',
    activity_drop:    'Activity drop',
    error_regression: 'Regression',
  }

  const stats = [
    {
      label: 'Open errors',
      value: formatNumber(openErrors ?? 0),
      icon: AlertTriangle,
      color: 'text-destructive',
      bg: 'bg-destructive/10 border-destructive/20',
      href: `/${orgSlug}/errors`,
    },
    {
      label: 'Active alerts',
      value: formatNumber(recentAlerts?.length ?? 0),
      icon: Bell,
      color: 'text-amber-500',
      bg: 'bg-amber-500/10 border-amber-500/20',
      href: `/${orgSlug}/alerts`,
    },
    {
      label: 'Sessions (24h)',
      value: formatNumber(activeSessions ?? 0),
      icon: Users,
      color: 'text-blue-500',
      bg: 'bg-blue-500/10 border-blue-500/20',
      href: `/${orgSlug}/sessions`,
    },
    {
      label: 'Peak p99',
      value: latencySnapshot && latencySnapshot.length > 0
        ? `${Math.max(...latencySnapshot.map((r: { p99: number | null }) => r.p99 ?? 0)).toFixed(0)}ms`
        : '—',
      icon: Zap,
      color: 'text-violet-500',
      bg: 'bg-violet-500/10 border-violet-500/20',
      href: `/${orgSlug}/performance`,
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">Real-time platform health at a glance</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, color, bg, href }) => (
          <Link key={label} href={href}>
            <Card className={`border transition-all hover:shadow-md ${bg}`}>
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">{label}</p>
                    <p className={`mt-2 text-2xl sm:text-3xl font-bold tabular-nums ${color}`}>{value}</p>
                  </div>
                  <div className={`rounded-lg p-2 ${bg}`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
        {/* Active alerts */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Active alerts</CardTitle>
              <Link href={`/${orgSlug}/alerts`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!recentAlerts || recentAlerts.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
                  <Bell className="h-5 w-5 text-emerald-500" />
                </div>
                <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">All clear</p>
                <p className="text-xs text-muted-foreground">No active alerts detected</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {recentAlerts.map((alert) => (
                  <div key={alert.id} className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <Badge variant="warning">{alertTypeLabel[alert.type] ?? alert.type}</Badge>
                      <span className="text-xs text-muted-foreground">{formatRelativeTime(alert.started_at)}</span>
                    </div>
                    {alert.ai_explanation ? (
                      <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{alert.ai_explanation}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {alert.metric_value?.toFixed(1)} observed · {alert.baseline_value?.toFixed(1)} baseline · {alert.deviation_percent?.toFixed(1)}% deviation
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top errors */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Recent errors</CardTitle>
              <Link href={`/${orgSlug}/errors`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!topErrors || topErrors.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
                  <AlertTriangle className="h-5 w-5 text-emerald-500" />
                </div>
                <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">No open errors</p>
                <p className="text-xs text-muted-foreground">Your app is running clean</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {topErrors.map(err => (
                  <Link
                    key={err.id}
                    href={`/${orgSlug}/errors/${err.id}`}
                    className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0 hover:opacity-80 transition-opacity group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground group-hover:text-primary transition-colors">{err.title}</p>
                      {err.culprit && (
                        <p className="truncate text-xs text-muted-foreground font-mono mt-0.5">{err.culprit}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-foreground">{formatNumber(err.occurrence_count)}</p>
                      <p className="text-xs text-muted-foreground">{formatRelativeTime(err.last_seen)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
