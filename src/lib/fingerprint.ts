import { createHash } from 'crypto'

interface StackFrame {
  file?: string
  filename?: string
  function?: string
  lineno?: number
  colno?: number
  context_line?: string
}

interface ErrorEvent {
  message: string
  exception_type?: string
  stack_trace?: StackFrame[]
}

// Vendor/runtime paths to exclude from fingerprinting
const VENDOR_PATTERNS = [
  /node_modules/,
  /next\/dist/,
  /<anonymous>/,
  /internal\//,
  /^node:/,
  /webpack/,
  /turbopack/,
]

function isVendorFrame(frame: StackFrame): boolean {
  const path = frame.file || frame.filename || ''
  return VENDOR_PATTERNS.some(p => p.test(path))
}

/**
 * Normalize a message by stripping dynamic values to produce
 * a stable string across different occurrences of the same bug.
 */
function normalizeMessage(message: string): string {
  return message
    // UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    // Email addresses
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '<email>')
    // URLs
    .replace(/https?:\/\/[^\s'"]+/g, '<url>')
    // Quoted strings (single and double)
    .replace(/'[^']{1,100}'/g, "'<str>'")
    .replace(/"[^"]{1,100}"/g, '"<str>"')
    // Numbers (standalone, not part of words)
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    // Hex strings (IDs, hashes)
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .trim()
    // Truncate to keep hash input bounded
    .substring(0, 500)
}

/**
 * Compute a stable fingerprint for an error event.
 *
 * Why not exact message matching:
 *  - Dynamic values (user IDs, record counts, emails) make every occurrence unique
 *  - Line numbers shift between deploys
 *  - The same bug in different locales produces different messages
 *
 * Strategy:
 *  1. Normalize the message (strip dynamic values)
 *  2. Take the top 3 non-vendor stack frames (file + function, NOT line number)
 *  3. Include exception_type for specificity
 *  4. SHA-256 the combination
 */
export function computeFingerprint(event: ErrorEvent): string {
  const normalizedMessage = normalizeMessage(event.message || '')

  const relevantFrames = (event.stack_trace || [])
    .filter(frame => !isVendorFrame(frame))
    .slice(0, 3)
    .map(frame => {
      const file = (frame.file || frame.filename || '').replace(/\?.*$/, '') // strip query params
      const fn = frame.function || '<fn>'
      return `${file}:${fn}`
    })

  const components = [
    event.exception_type || '',
    normalizedMessage,
    ...relevantFrames,
  ].join('|')

  return createHash('sha256').update(components).digest('hex')
}

/**
 * Build the title (short description) for an error group.
 * Used as the display name in the error list.
 */
export function buildErrorTitle(event: ErrorEvent): string {
  const type = event.exception_type
  const message = event.message || ''
  if (type) {
    return `${type}: ${message.substring(0, 120)}`
  }
  return message.substring(0, 120)
}

/**
 * Get the culprit (top relevant frame) for display.
 */
export function buildCulprit(event: ErrorEvent): string | undefined {
  const topFrame = (event.stack_trace || []).find(f => !isVendorFrame(f))
  if (!topFrame) return undefined
  const file = topFrame.file || topFrame.filename || ''
  const fn = topFrame.function
  const line = topFrame.lineno
  return [fn, file, line ? `L${line}` : ''].filter(Boolean).join(' in ')
}
