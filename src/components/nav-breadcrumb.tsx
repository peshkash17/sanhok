'use client'

import { usePathname } from 'next/navigation'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

const SECTION_LABELS: Record<string, string> = {
  errors:      'Errors',
  sessions:    'Sessions',
  performance: 'Performance',
  alerts:      'Alerts',
  settings:    'Settings',
}

export function NavBreadcrumb({ orgName, orgSlug }: { orgName: string; orgSlug: string }) {
  const pathname = usePathname()
  // e.g. /acme/errors/abc → ['', 'acme', 'errors', 'abc']
  const parts = pathname.split('/').filter(Boolean)
  const section = parts[1] // index 0 is orgSlug
  const sectionLabel = section ? SECTION_LABELS[section] : null

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {sectionLabel ? (
            <span className="text-muted-foreground text-sm">{orgName}</span>
          ) : (
            <BreadcrumbPage className="font-medium">{orgName}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {sectionLabel && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-medium">{sectionLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
