import { redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Card, CardContent } from '@/components/ui/card'
import { formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { AlertActions } from './alert-actions'
import { Bell, Sparkles } from 'lucide-react'

interface Props {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ resolved?: string }>
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  error_spike: 'Error spike',
  latency_drift: 'Latency drift',
  activity_drop: 'Activity drop',
  error_regression: 'Regression',
}

const ALERT_TYPE_VARIANT: Record<string, 'error' | 'warning' | 'info' | 'muted'> = {
  error_spike: 'error',
  latency_drift: 'warning',
  activity_drop: 'info',
  error_regression: 'warning',
}

export default async function AlertsPage({ params, searchParams }: Props) {
  const { orgSlug } = await params
  const { resolved = '0' } = await searchParams

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  let query = svc
    .from('alerts')
    .select('id, type, metric_value, baseline_value, deviation_percent, duration_minutes, started_at, resolved_at, ai_explanation, context')
    .eq('org_id', orgId)
    .order('started_at', { ascending: false })
    .limit(50)

  if (resolved === '0') {
    query = query.is('resolved_at', null)
  } else {
    query = query.not('resolved_at', 'is', null)
  }

  const { data: alerts } = await query

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Alerts</h1>
          <p className="mt-1 text-sm text-muted-foreground">Anomaly detection results</p>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden w-fit">
          {[
            { label: 'Active', value: '0' },
            { label: 'Resolved', value: '1' },
          ].map(({ label, value }) => (
            <a
              key={value}
              href={`/${orgSlug}/alerts?resolved=${value}`}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                resolved === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              {label}
            </a>
          ))}
        </div>
      </div>

      {!alerts || alerts.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-7 w-7" />}
          title={resolved === '0' ? 'No active alerts' : 'No resolved alerts'}
          description={resolved === '0' ? "Anomaly detection runs automatically. You'll see alerts here when spikes, latency drifts, or activity drops are detected." : undefined}
        />
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => {
            const ctx = alert.context as Record<string, unknown> | null
            const deviationSign = (alert.deviation_percent ?? 0) > 0 ? '+' : ''
            return (
              <Card
                key={alert.id}
                className={cn(
                  'transition-opacity',
                  alert.resolved_at
                    ? 'opacity-60 border-border/50'
                    : 'border-amber-900/40 bg-amber-950/5'
                )}
              >
                <CardContent className="p-4 space-y-3">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={ALERT_TYPE_VARIANT[alert.type] ?? 'warning'}>
                        {ALERT_TYPE_LABELS[alert.type] ?? alert.type}
                      </Badge>
                      {alert.resolved_at ? (
                        <Badge variant="success">Resolved</Badge>
                      ) : (
                        <Badge variant="error">Active</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{formatRelativeTime(alert.started_at)}</span>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <p className={cn(
                          'text-lg font-bold tabular-nums',
                          (alert.deviation_percent ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400'
                        )}>
                          {deviationSign}{alert.deviation_percent?.toFixed(1)}%
                        </p>
                        <p className="text-xs text-muted-foreground">deviation</p>
                      </div>
                      <AlertActions
                        alertId={alert.id}
                        orgSlug={orgSlug}
                        resolved={!!alert.resolved_at}
                      />
                    </div>
                  </div>

                  {/* Metric summary */}
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <div>
                      <span className="text-xs text-muted-foreground">Observed: </span>
                      <span className="font-mono text-foreground">{alert.metric_value?.toFixed(1)}</span>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">Baseline: </span>
                      <span className="font-mono text-muted-foreground">{alert.baseline_value?.toFixed(1)}</span>
                    </div>
                    {ctx?.operation != null && (
                      <div>
                        <span className="text-xs text-muted-foreground">Operation: </span>
                        <span className="font-mono text-muted-foreground">{String(ctx.operation)}</span>
                      </div>
                    )}
                    {ctx?.slope_ms_per_hour != null && (
                      <div>
                        <span className="text-xs text-muted-foreground">Slope: </span>
                        <span className="font-mono text-amber-400">+{String(ctx.slope_ms_per_hour)} ms/hr</span>
                      </div>
                    )}
                  </div>

                  {/* AI explanation */}
                  {alert.ai_explanation ? (
                    <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Sparkles className="h-3 w-3 text-primary" />
                        <p className="text-xs text-primary font-medium">AI Analysis</p>
                      </div>
                      <p className="text-sm text-foreground/80">{alert.ai_explanation}</p>
                    </div>
                  ) : (
                    !alert.resolved_at && (
                      <p className="text-xs text-muted-foreground/50 italic">AI analysis pending…</p>
                    )
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
