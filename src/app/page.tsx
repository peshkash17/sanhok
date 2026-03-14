import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'

export default async function HomePage() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const serviceClient = createSupabaseServiceClient()
  const { data: memberships } = await serviceClient
    .from('org_members')
    .select('org_id, role, organisations(id, name, slug)')
    .eq('user_id', user.id)

  if (!memberships || memberships.length === 0) {
    redirect('/new-org')
  }

  if (memberships.length === 1) {
    const org = memberships[0].organisations as { slug: string } | null
    if (org) redirect(`/${org.slug}`)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md px-4">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">Select organisation</h1>
          <p className="mt-1 text-sm text-muted-foreground">Choose an organisation to continue</p>
        </div>

        <div className="flex flex-col gap-2">
          {memberships.map((m) => {
            const org = m.organisations as { id: string; name: string; slug: string } | null
            if (!org) return null
            return (
              <Link
                key={org.id}
                href={`/${org.slug}`}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <div>
                  <p className="font-medium text-foreground">{org.name}</p>
                  <p className="text-xs text-muted-foreground">{m.role}</p>
                </div>
                <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            )
          })}
        </div>

        <div className="mt-6 text-center">
          <Link href="/new-org" className="text-sm text-primary hover:text-primary/80">
            + Create new organisation
          </Link>
        </div>
      </div>
    </div>
  )
}
