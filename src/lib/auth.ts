import { createSupabaseServiceClient } from './supabase/server'
import { hashApiKey } from './api-key'

export interface ResolvedApiKey {
  orgId: string
  keyId: string
}

/**
 * Resolve an API key from the Authorization header.
 * Returns null if the key is missing, invalid, or revoked.
 *
 * Security:
 * - The raw key is never stored; only its SHA-256 hash
 * - The service client is used for the lookup (bypasses RLS — org_id is not yet known)
 * - After resolution, SET LOCAL is used in all subsequent queries
 */
export async function resolveApiKey(authHeader: string | null): Promise<ResolvedApiKey | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null

  const rawKey = authHeader.slice(7).trim()
  if (!rawKey || rawKey.length < 10) return null

  const keyHash = hashApiKey(rawKey)
  const supabase = createSupabaseServiceClient()

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, org_id, revoked_at')
    .eq('key_hash', keyHash)
    .single()

  if (error || !data) return null
  if (data.revoked_at) return null

  // Update last_used_at asynchronously (fire and forget — don't block ingestion)
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  return { orgId: data.org_id, keyId: data.id }
}

/**
 * Resolve the current user's membership in a given org (by slug).
 * Used by dashboard API routes.
 *
 * Returns null if the user is not a member.
 */
export async function resolveOrgMembership(
  userId: string,
  orgSlug: string
): Promise<{ orgId: string; role: 'owner' | 'admin' | 'member' } | null> {
  const supabase = createSupabaseServiceClient()

  const { data, error } = await supabase
    .from('organisations')
    .select('id, org_members!inner(role)')
    .eq('slug', orgSlug)
    .eq('org_members.user_id', userId)
    .single()

  if (error || !data) return null

  const members = data.org_members as Array<{ role: string }>
  if (!members || members.length === 0) return null

  return {
    orgId: data.id,
    role: members[0].role as 'owner' | 'admin' | 'member',
  }
}
