'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Activity, AlertTriangle } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html>
      <body className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center font-sans antialiased">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 border border-destructive/20">
          <AlertTriangle className="h-7 w-7 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-sm">
          An unexpected error occurred. You can try again or go back to the home page.
        </p>
        {error.digest && (
          <p className="mt-2 text-xs text-muted-foreground font-mono">Error ID: {error.digest}</p>
        )}
        <div className="mt-6 flex gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" render={<Link href="/" />}>
            Home
          </Button>
        </div>
      </body>
    </html>
  )
}
