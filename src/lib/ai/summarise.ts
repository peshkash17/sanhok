import OpenAI from 'openai'

function getClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.AI_BASE_URL ?? undefined,
  })
}

const AI_MODEL = process.env.AI_MODEL ?? 'gpt-4o'

export interface BehaviourSummary {
  summary: string
  key_actions: string[]
  anomalies: string[]
}

export async function summariseSession(params: {
  session_id: string
  user_id?: string
  duration_seconds: number
  event_count: number
  events: Array<{
    type: string
    name?: string
    timestamp: string
    properties?: Record<string, unknown>
  }>
}): Promise<BehaviourSummary | null> {
  if (!process.env.OPENAI_API_KEY) return null

  const eventLines = params.events
    .slice(0, 50) // cap to avoid token overflow
    .map((e) => {
      const t = new Date(e.timestamp).toISOString().substring(11, 19)
      const name = e.name ? ` "${e.name}"` : ''
      return `[${t}] ${e.type}${name}`
    })
    .join('\n')

  const prompt = `You are analyzing a user session from an observability platform.

Session info:
- Session ID: ${params.session_id}
${params.user_id ? `- User: ${params.user_id}` : '- User: anonymous'}
- Duration: ${params.duration_seconds}s
- Total events: ${params.event_count}

Event timeline (up to 50 events):
${eventLines}

Provide a concise JSON response with three keys:
- "summary": One paragraph (2-3 sentences) describing what the user did in this session
- "key_actions": Array of up to 5 strings, each describing a notable user action
- "anomalies": Array of up to 3 strings describing anything unusual (errors, rage clicks, unexpected navigation). Empty array if nothing unusual.

Respond with raw JSON only, no markdown.`

  try {
    const response = await getClient().chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    })

    const text = response.choices[0]?.message?.content
    if (!text) return null
    return JSON.parse(text) as BehaviourSummary
  } catch {
    return null
  }
}
