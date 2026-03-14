'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Activity } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const siteUrl = window.location.origin
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${siteUrl}/reset-password`,
    })

    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setSent(true)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
          <Activity className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Reset password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {sent ? "Check your inbox" : "We'll send you a reset link"}
          </p>
        </div>
      </div>

      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {sent ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                A password reset link has been sent to <strong className="text-foreground">{email}</strong>.
                Check your inbox (and spam folder).
              </p>
              <p className="text-xs text-muted-foreground">
                Invited users: click the link to set a new password, then sign in normally.
              </p>
              <Link href="/login" className="block mt-4 text-sm font-medium text-primary hover:text-primary/80">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                label="Email address"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" loading={loading} className="w-full mt-1">
                Send reset link
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                <Link href="/login" className="font-medium text-primary hover:text-primary/80">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
