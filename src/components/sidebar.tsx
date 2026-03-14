'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  LayoutDashboard,
  Bug,
  Users,
  Zap,
  Bell,
  Settings,
  LogOut,
  Sun,
  Moon,
  ChevronDown,
  Check,
  ChevronsUpDown,
} from 'lucide-react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { useTheme } from '@/components/theme-provider'

interface OrgInfo {
  name: string
  slug: string
}

export interface AppSidebarProps {
  orgSlug: string
  orgName: string
  userEmail: string
  allOrgs: OrgInfo[]
}

const navItems = (orgSlug: string) => {
  const base = `/${orgSlug}`
  return {
    main: [
      { label: 'Overview',    href: base,                  icon: LayoutDashboard },
      { label: 'Errors',      href: `${base}/errors`,      icon: Bug },
      { label: 'Sessions',    href: `${base}/sessions`,    icon: Users },
      { label: 'Performance', href: `${base}/performance`, icon: Zap },
      { label: 'Alerts',      href: `${base}/alerts`,      icon: Bell },
    ],
    settings: [
      { label: 'Settings', href: `${base}/settings`, icon: Settings },
    ],
  }
}

export function AppSidebar({ orgSlug, orgName, userEmail, allOrgs }: AppSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const base = `/${orgSlug}`
  const { main, settings } = navItems(orgSlug)

  const isActive = (href: string) =>
    href === base ? pathname === base : pathname.startsWith(href)

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <Sidebar collapsible="icon">
      {/* Org switcher */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground shrink-0">
                    {orgName.charAt(0).toUpperCase()}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{orgName}</span>
                    <span className="truncate text-xs text-sidebar-foreground/50">Organisation</span>
                  </div>
                  <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-sidebar-foreground/40" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-56">
                {allOrgs.map(org => (
                  <DropdownMenuItem key={org.slug} asChild>
                    <Link href={`/${org.slug}`} className="flex items-center gap-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-[10px] font-bold text-primary shrink-0">
                        {org.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="flex-1 truncate">{org.name}</span>
                      {org.slug === orgSlug && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </Link>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/new-org">+ New organisation</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* Nav */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Monitor</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {main.map(item => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={isActive(item.href)}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {settings.map(item => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={isActive(item.href)}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer: user + theme + logout */}
      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary shrink-0">
                    {userEmail.charAt(0).toUpperCase()}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate text-xs text-sidebar-foreground/60">{userEmail}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-sidebar-foreground/40" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark'
                    ? <><Sun className="h-4 w-4 mr-2" />Light mode</>
                    : <><Moon className="h-4 w-4 mr-2" />Dark mode</>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                  <LogOut className="h-4 w-4 mr-2" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
