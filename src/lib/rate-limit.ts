import { createSupabaseServiceClient } from './supabase/server'

const RATE_LIMIT_TOKENS_PER_MINUTE = 1000
const REFILL_INTERVAL_MS = 60_000 // 1 minute

/**
 * Token-bucket rate limiter backed by Postgres.
 *
 * Each org starts with RATE_LIMIT_TOKENS_PER_MINUTE tokens.
 * Tokens refill linearly over time (continuous refill model).
 * Each event consumes 1 token.
 *
 * Returns: { allowed: boolean, remaining: number, resetAt: Date }
 */
export async function checkRateLimit(
  orgId: string,
  eventCount: number
): Promise<{ allowed: boolean; remaining: number; resetAfterMs: number }> {
  const supabase = createSupabaseServiceClient()
  const now = new Date()

  // Upsert the rate limit state row, refilling tokens based on elapsed time
  const { data, error } = await supabase.rpc('check_and_consume_tokens', {
    p_org_id: orgId,
    p_consume: eventCount,
    p_max_tokens: RATE_LIMIT_TOKENS_PER_MINUTE,
    p_refill_per_ms: RATE_LIMIT_TOKENS_PER_MINUTE / REFILL_INTERVAL_MS,
  })

  if (error) {
    // Fail open — if rate limit check itself fails, allow the request
    // Log the error for monitoring but don't block legitimate traffic
    console.error('[rate-limit] check failed, failing open:', error.message)
    return { allowed: true, remaining: RATE_LIMIT_TOKENS_PER_MINUTE, resetAfterMs: 0 }
  }

  const rpcResult = data as unknown as { allowed: boolean; remaining: number } | null
  const remaining = Math.max(0, rpcResult?.remaining ?? 0)
  const resetAfterMs = remaining > 0 ? 0 : REFILL_INTERVAL_MS

  return {
    allowed: rpcResult?.allowed ?? true,
    remaining,
    resetAfterMs,
  }
}
