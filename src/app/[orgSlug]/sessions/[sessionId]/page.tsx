import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { formatRelativeTime } from '@/lib/utils'
import { ChevronRight, MousePointer2, FileText, User, Zap, Circle } from 'lucide-react'

interface Props {
  params: Promise<{ orgSlug: string; sessionId: string }>
}

const EVENT_ICON: Record<string, React.ElementType> = {
  page:     FileText,
  click:    MousePointer2,
  identify: User,
  custom:   Zap,
}

const EVENT_COLOR: Record<string, string> = {
  page:     'text-blue-400 bg-blue-950/30 border-blue-900/40',
  click:    'text-amber-400 bg-amber-950/30 border-amber-900/40',
  identify: 'text-violet-400 bg-violet-950/30 border-violet-900/40',
  custom:   'text-emerald-400 bg-emerald-950/30 border-emerald-900/40',
}

const DOT_COLOR: Record<string, string> = {
  page:     'bg-blue-500',
  click:    'bg-amber-500',
  identify: 'bg-violet-500',
  custom:   'bg-emerald-500',
}

export default async function SessionDetailPage({ params }: Props) {
  const { orgSlug, sessionId } = await params

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const { orgId } = membership
  const svc = createSupabaseServiceClient()

  const [{ data: session }, { data: events }] = await Promise.all([
    svc.from('sessions').select('*').eq('org_id', orgId).eq('id', sessionId).single(),
    svc.from('session_events')
      .select('id, event_type, event_name, properties, url, referrer, occurred_at')
      .eq('org_id', orgId)
      .eq('session_id', (await svc.from('sessions').select('session_id').eq('id', sessionId).eq('org_id', orgId).single()).data?.session_id ?? '')
      .order('occurred_at', { ascending: true })
      .limit(500),
  ])

  if (!session) notFound()

  const duration = session.duration_seconds
  const durationLabel = duration
    ? duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`
    : null

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href={`/${orgSlug}/sessions`} className="hover:text-foreground transition-colors">Sessions</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground font-mono">{session.session_id.slice(0, 16)}...</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {session.user_id
            ? <Badge variant="info">identified</Badge>
            : <Badge variant="muted">anonymous</Badge>
          }
          {durationLabel && <Badge variant="default">{durationLabel}</Badge>}
        </div>
        <h1 className="text-xl font-bold text-foreground">
          {session.user_id ? `User: ${session.user_id}` : `Anon: ${session.anonymous_id.slice(0, 24)}...`}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatRelativeTime(session.started_at)}
          {session.ended_at && ` · ended ${formatRelativeTime(session.ended_at)}`}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Events', value: String(events?.length ?? 0) },
          { label: 'Started', value: formatRelativeTime(session.started_at) },
          { label: 'Duration', value: durationLabel ?? '—' },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1.5 text-lg font-semibold text-foreground">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Event timeline</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {!events || events.length === 0 ? (
            <EmptyState
              title="No events recorded"
              description="No events were captured for this session."
              className="border-none py-10"
            />
          ) : (
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-4.5 top-2 bottom-2 w-px bg-border" />

              <div className="space-y-2">
                {events.map((event) => {
                  const Icon = EVENT_ICON[event.event_type] ?? Circle
                  const colorClass = EVENT_COLOR[event.event_type] ?? 'text-muted-foreground bg-muted/20 border-border'
                  const dotClass = DOT_COLOR[event.event_type] ?? 'bg-muted-foreground'
                  const props = event.properties as Record<string, unknown> | null
                  return (
                    <div key={event.id} className="relative flex items-start gap-4 pl-10">
                      {/* Dot */}
                      <div className={`absolute left-3 top-3 h-2.5 w-2.5 rounded-full border-2 border-background z-10 ${dotClass}`} />

                      <div className={`flex-1 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/20 ${colorClass}`}>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon className="h-3.5 w-3.5 shrink-0" />
                            <span className="text-sm font-medium truncate">{event.event_name}</span>
                            <Badge variant="muted" className="text-[10px]">{event.event_type}</Badge>
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                            {formatRelativeTime(event.occurred_at)}
                          </span>
                        </div>
                        {event.url && (
                          <p className="text-xs text-muted-foreground/70 font-mono mt-1 truncate">{event.url}</p>
                        )}
                        {props && Object.keys(props).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {Object.entries(props).slice(0, 5).map(([k, v]) => (
                              <span key={k} className="text-[10px] bg-background/50 rounded px-1.5 py-0.5 text-muted-foreground">
                                {k}: <span className="text-foreground/70">{String(v)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
