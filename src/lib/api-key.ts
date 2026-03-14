import { createHash, randomBytes } from 'crypto'

const KEY_PREFIX = 'sk_live_'
const KEY_BYTES = 32

/**
 * Generate a new API key.
 * Returns the raw key (shown ONCE to user) and the hash + prefix for storage.
 */
export function generateApiKey(): {
  rawKey: string
  keyHash: string
  prefix: string
} {
  const random = randomBytes(KEY_BYTES).toString('base64url')
  const rawKey = `${KEY_PREFIX}${random}`
  const keyHash = hashApiKey(rawKey)
  const prefix = rawKey.substring(0, 16)
  return { rawKey, keyHash, prefix }
}

/**
 * Hash an API key for storage.
 * Deterministic: same key always produces the same hash.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/**
 * Hash an invitation token.
 */
export function generateInvitationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  return { rawToken, tokenHash }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
