import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Activity } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
        <Activity className="h-7 w-7 text-primary" />
      </div>
      <h1 className="text-5xl font-bold tabular-nums text-foreground">404</h1>
      <p className="mt-3 text-lg font-medium text-foreground">Page not found</p>
      <p className="mt-1 text-sm text-muted-foreground max-w-xs">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Button render={<Link href="/" />} className="mt-6">
        Back to home
      </Button>
    </div>
  )
}
