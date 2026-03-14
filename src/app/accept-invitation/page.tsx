'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

function AcceptInvitationContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [status, setStatus] = useState<'loading' | 'ready' | 'accepting' | 'success' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<{ email?: string } | null>(null)

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()

    // Supabase invite emails use the implicit flow — the access_token is in the
    // URL hash fragment (not query params). Server-side routes never see fragments,
    // so we handle session establishment here on the client.
    const hash = window.location.hash
    if (hash && hash.includes('access_token')) {
      const params = new URLSearchParams(hash.slice(1)) // strip leading '#'
      const accessToken = params.get('access_token')
      const refreshToken = params.get('refresh_token')

      if (accessToken && refreshToken) {
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          .then(({ data }) => {
            setUser(data.user)
            setStatus('ready')
            // Clean the hash from the URL without triggering a navigation
            window.history.replaceState(null, '', window.location.pathname + window.location.search)
          })
        return
      }
    }

    // Normal flow — user already has a session (came from login or PKCE callback)
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setStatus(data.user ? 'ready' : 'ready')
    })
  }, [])

  async function handleAccept() {
    setStatus('accepting')
    setError(null)

    const supabase = createSupabaseBrowserClient()
    const { data: { user: currentUser } } = await supabase.auth.getUser()

    if (!currentUser) {
      // Redirect to login, then come back
      router.push(`/login?redirectTo=${encodeURIComponent(`/accept-invitation?token=${token}`)}`)
      return
    }

    const res = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Failed to accept invitation.')
      setStatus('error')
      return
    }

    setStatus('success')
    setTimeout(() => router.push(`/${data.org_slug}`), 1500)
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="text-center">
          <p className="text-destructive">Invalid invitation link. No token provided.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <div className="rounded-xl border border-border bg-card p-8 shadow-sm">
          {status === 'success' ? (
            <div>
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-950/50 border border-emerald-800/50">
                <svg className="h-6 w-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-foreground">You&apos;re in!</h2>
              <p className="mt-1 text-sm text-muted-foreground">Redirecting to your dashboard…</p>
            </div>
          ) : (
            <div>
              <h2 className="text-lg font-semibold text-foreground">Organisation Invitation</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                You&apos;ve been invited to join an organisation on Sanhok.
              </p>

              {error && (
                <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive border border-destructive/30">
                  {error}
                </p>
              )}

              <Button
                onClick={handleAccept}
                loading={status === 'accepting'}
                className="mt-6 w-full"
              >
                Accept invitation
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    }>
      <AcceptInvitationContent />
    </Suspense>
  )
}
