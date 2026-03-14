'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

interface AlertActionsProps {
  alertId: string
  orgSlug: string
  resolved: boolean
}

export function AlertActions({ alertId, orgSlug, resolved }: AlertActionsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    setError(null)
    const res = await fetch(`/api/alerts/${alertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug, resolved: !resolved }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Failed to update alert')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-400">{error}</span>}
      <Button
        variant={resolved ? 'secondary' : 'ghost'}
        onClick={toggle}
        disabled={isPending}
      >
        {isPending ? 'Saving…' : resolved ? 'Reopen' : 'Resolve'}
      </Button>
    </div>
  )
}
