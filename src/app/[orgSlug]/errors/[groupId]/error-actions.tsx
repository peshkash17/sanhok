'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

interface Props {
  groupId: string
  orgSlug: string
  currentStatus: string
}

export function ErrorActions({ groupId, orgSlug, currentStatus }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const updateStatus = async (newStatus: 'resolved' | 'ignored' | 'open') => {
    setError(null)
    const res = await fetch(`/api/errors/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, orgSlug }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to update status')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {error && <span className="text-xs text-red-400">{error}</span>}
      {currentStatus !== 'resolved' && (
        <Button
          variant="secondary"
          onClick={() => updateStatus('resolved')}
          disabled={isPending}
        >
          Resolve
        </Button>
      )}
      {currentStatus !== 'ignored' && (
        <Button
          variant="ghost"
          onClick={() => updateStatus('ignored')}
          disabled={isPending}
        >
          Ignore
        </Button>
      )}
      {(currentStatus === 'resolved' || currentStatus === 'ignored') && (
        <Button
          variant="secondary"
          onClick={() => updateStatus('open')}
          disabled={isPending}
        >
          Reopen
        </Button>
      )}
    </div>
  )
}
