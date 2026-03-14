import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveApiKey } from '@/lib/auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { computeFingerprint, buildErrorTitle, buildCulprit } from '@/lib/fingerprint'
import { createSupabaseServiceClient } from '@/lib/supabase/server'

// ─── CORS ───────────────────────────────────────────────────────────────────
// Public ingestion endpoint — must be callable from browser SDKs on any origin.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
} as const

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

function json(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...CORS, ...(init.headers as Record<string, string> | undefined ?? {}) },
  })
}

// ─── Zod schemas per event type ────────────────────────────────────────────

const StackFrameSchema = z.object({
  file: z.string().optional(),
  filename: z.string().optional(),
  function: z.string().optional(),
  lineno: z.number().int().optional(),
  colno: z.number().int().optional(),
  context_line: z.string().optional(),
})

const ErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string().min(1).max(4096),
  exception_type: z.string().max(256).optional(),
  stack_trace: z.array(StackFrameSchema).max(100).optional(),
  user_id: z.string().max(256).optional(),
  user_email: z.string().email().optional(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  breadcrumbs: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  request_url: z.string().url().max(2048).optional(),
  request_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  occurred_at: z.string().optional(),
  sdk_version: z.string().max(64).optional(),
  environment: z.string().max(64).optional().default('production'),
  release: z.string().max(256).optional(),
})

const ActivityEventSchema = z.object({
  type: z.literal('activity'),
  session_id: z.string().min(1).max(256),
  anonymous_id: z.string().min(1).max(256),
  user_id: z.string().max(256).optional(),
  event_type: z.enum(['page_view', 'custom', 'identify', 'click', 'form_submit', 'error']),
  event_name: z.string().min(1).max(256),
  properties: z.record(z.string(), z.unknown()).optional(),
  url: z.string().url().max(2048).optional(),
  referrer: z.string().url().max(2048).optional(),
  occurred_at: z.string().optional(),
})

const TraceEventSchema = z.object({
  type: z.literal('trace'),
  trace_id: z.string().min(1).max(256),
  span_id: z.string().min(1).max(256),
  parent_span_id: z.string().max(256).optional(),
  operation: z.string().min(1).max(256),
  duration_ms: z.number().nonnegative().max(3_600_000), // max 1 hour
  status: z.enum(['ok', 'error', 'timeout']).optional().default('ok'),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  tags: z.record(z.string(), z.string().max(256)).optional(),
  resource_attributes: z.record(z.string(), z.unknown()).optional(),
})

const EventSchema = z.discriminatedUnion('type', [ErrorEventSchema, ActivityEventSchema, TraceEventSchema])

const IngestBatchSchema = z.object({
  idempotency_key: z.string().min(1).max(128),
  events: z.array(EventSchema).min(1).max(100),
})

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Authenticate via API key
  const resolved = await resolveApiKey(request.headers.get('authorization'))
  if (!resolved) {
    return json(
      { error: 'Invalid or missing API key. Provide a valid key in the Authorization header as: Bearer sk_live_...' },
      { status: 401 }
    )
  }
  const { orgId } = resolved

  // 2. Parse body
  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }

  // 3. Validate schema
  const parseResult = IngestBatchSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return json(
      {
        error: 'Validation failed.',
        details: parseResult.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 422 }
    )
  }

  const { idempotency_key, events } = parseResult.data

  // 4. Rate limit check
  const rateLimit = await checkRateLimit(orgId, events.length)
  if (!rateLimit.allowed) {
    return json(
      {
        error: 'Rate limit exceeded.',
        retry_after_ms: rateLimit.resetAfterMs,
        remaining: rateLimit.remaining,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rateLimit.resetAfterMs / 1000)),
          'X-RateLimit-Remaining': String(rateLimit.remaining),
        },
      }
    )
  }

  // 5. Enrich error events with fingerprint before queuing
  const enrichedPayloads = events.map(event => {
    if (event.type === 'error') {
      const fingerprint = computeFingerprint({
        message: event.message,
        exception_type: event.exception_type,
        stack_trace: event.stack_trace,
      })
      return {
        ...event,
        fingerprint,
        title: buildErrorTitle({ message: event.message, exception_type: event.exception_type }),
        culprit: buildCulprit({ message: event.message, stack_trace: event.stack_trace }),
      }
    }
    return event
  })

  // 6. Write to ingestion_queue (idempotent)
  const supabase = createSupabaseServiceClient()

  const queueRows = enrichedPayloads.map((payload, index) => ({
    org_id: orgId,
    event_type: payload.type,
    payload: payload as unknown as import('@/lib/supabase/database.types').Json,
    // Incorporate index into idempotency key so each event in the batch is independently idempotent
    idempotency_key: events.length === 1 ? idempotency_key : `${idempotency_key}:${index}`,
  }))

  const { error: insertError } = await supabase
    .from('ingestion_queue')
    .upsert(queueRows, { onConflict: 'org_id,idempotency_key', ignoreDuplicates: true })

  if (insertError && !insertError.message.includes('duplicate') && !insertError.message.includes('unique')) {
    console.error('[POST /api/ingest]', insertError)
    return json(
      { error: 'Failed to enqueue events. Please retry with the same idempotency_key.' },
      { status: 503 }
    )
  }

  return json(
    {
      accepted: events.length,
      message: 'Events accepted and queued for processing.',
    },
    {
      status: 200,
      headers: {
        'X-RateLimit-Remaining': String(rateLimit.remaining),
      },
    }
  )
}
