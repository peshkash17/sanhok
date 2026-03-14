import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { Database } from './database.types'

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
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
            // setAll can throw in Server Components; safe to ignore
          }
        },
      },
    }
  )
}

/**
 * Service-role client for server-side operations that bypass RLS.
 * ONLY use for:
 *  - API key lookup during ingestion auth (before org_id is known)
 *  - Queue drainer (runs as a privileged internal job)
 *  - Seed scripts
 * Never expose to client code.
 */
export function createSupabaseServiceClient() {
  // Use the named import — service role key never reaches the browser bundle
  // because this file is only imported in Server Components and API routes.
  const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js')
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}
