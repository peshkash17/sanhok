'use client'

import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './button'

interface ErrorStateProps {
  title?: string
  message?: string
  onRetry?: () => void
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'We ran into a problem loading this data.',
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="rounded-full bg-red-950 p-4">
        <AlertTriangle className="h-8 w-8 text-red-400" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-gray-200">{title}</h3>
        <p className="mt-1 text-sm text-gray-500">{message}</p>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      )}
    </div>
  )
}

// React error boundary wrapper
export class ErrorBoundary extends Error {}
