'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Activity } from 'lucide-react'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionReady, setSessionReady] = useState(false)

  // Supabase password-reset emails use the implicit flow: #access_token in the URL hash.
  // We must exchange the hash for a session before calling updateUser().
  useEffect(() => {
    const hash = window.location.hash
    if (!hash) return

    const params = new URLSearchParams(hash.slice(1))
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token') ?? ''
    const type = params.get('type')

    if (accessToken && type === 'recovery') {
      const supabase = createSupabaseBrowserClient()
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(() => {
        // Clean the URL so the token isn't visible or accidentally reused
        window.history.replaceState(null, '', window.location.pathname)
        setSessionReady(true)
      })
    }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setLoading(true)
    setError(null)
    const supabase = createSupabaseBrowserClient()
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (error) {
      setError(error.message)
    } else {
      setDone(true)
      setTimeout(() => router.push('/login'), 2500)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
          <Activity className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Set new password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {done ? 'Password updated — redirecting…' : 'Choose a password for your account'}
          </p>
        </div>
      </div>

      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {done ? (
            <p className="text-center text-sm text-muted-foreground">
              Your password has been set. You can now{' '}
              <Link href="/login" className="font-medium text-primary hover:text-primary/80">
                sign in
              </Link>
              .
            </p>
          ) : !sessionReady ? (
            <p className="text-center text-sm text-muted-foreground">
              Loading… if nothing happens,{' '}
              <Link href="/forgot-password" className="font-medium text-primary hover:text-primary/80">
                request a new link
              </Link>
              .
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                label="New password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                autoComplete="new-password"
              />
              <Input
                label="Confirm password"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                required
                autoComplete="new-password"
              />

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" loading={loading} className="w-full mt-1">
                Set password
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
