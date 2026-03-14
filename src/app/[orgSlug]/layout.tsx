import { redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server'
import { resolveOrgMembership } from '@/lib/auth'
import { AppSidebar } from '@/components/sidebar'
import { NavBreadcrumb } from '@/components/nav-breadcrumb'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'

interface OrgLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}

export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { orgSlug } = await params
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect(`/login?redirectTo=/${orgSlug}`)

  const membership = await resolveOrgMembership(user.id, orgSlug)
  if (!membership) redirect('/')

  const serviceClient = createSupabaseServiceClient()

  // Fetch current org + all orgs the user belongs to (for org switcher)
  const [{ data: org }, { data: memberships }] = await Promise.all([
    serviceClient.from('organisations').select('name, slug').eq('id', membership.orgId).single(),
    serviceClient.from('org_members').select('organisations(name, slug)').eq('user_id', user.id),
  ])

  if (!org) redirect('/')

  const allOrgs = (memberships ?? [])
    .map(m => m.organisations as { name: string; slug: string } | null)
    .filter((o): o is { name: string; slug: string } => o !== null)

  return (
    <SidebarProvider>
      <AppSidebar orgSlug={orgSlug} orgName={org.name} userEmail={user.email ?? ''} allOrgs={allOrgs} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <NavBreadcrumb orgName={org.name} orgSlug={orgSlug} />
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
