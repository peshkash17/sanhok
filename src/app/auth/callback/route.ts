import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/lib/supabase/database.types'

/**
 * Auth callback route — required for Supabase PKCE flow.
 * Handles:
 *   - Email confirmation (signup)
 *   - Invitation emails (inviteUserByEmail)
 *   - Magic link sign-ins
 *
 * After exchanging the code for a session, redirects to the `next` query param
 * (defaults to '/') so the accept-invitation page receives the user already signed in.
 *
 * Supabase Dashboard → Authentication → URL Configuration:
 *   - Add `http://localhost:3000/auth/callback` to "Redirect URLs"
 *   - In production add your Vercel URL too
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch {
              // May throw in certain RSC contexts; safe to ignore
            }
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Redirect to the originally intended destination (e.g. /accept-invitation?token=...)
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // If anything went wrong, send to login with an error flag
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
