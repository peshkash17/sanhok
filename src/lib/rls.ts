import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Set the current org context for RLS enforcement.
 * Must be called inside a transaction before any org-scoped queries.
 *
 * Uses SET LOCAL so the context is scoped to the current transaction only —
 * it cannot bleed into a subsequent request on a pooled connection.
 *
 * Security note: if orgId is null/undefined, current_setting('app.current_org_id', true)
 * returns NULL, and `NULL = any_uuid` evaluates to NULL (falsy), meaning ZERO rows
 * are returned from any RLS-protected table. Failing open returns empty, not all data.
 */
export async function setOrgContext(
  supabase: SupabaseClient,
  orgId: string
): Promise<void> {
  // Validate orgId is a UUID before interpolating (defence in depth)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(orgId)) {
    throw new Error(`Invalid orgId format: ${orgId}`)
  }

  const { error } = await supabase.rpc('set_org_context', { p_org_id: orgId })
  if (error) throw new Error(`Failed to set org context: ${error.message}`)
}
