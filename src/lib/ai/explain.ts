import OpenAI from 'openai'

function getClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.AI_BASE_URL ?? undefined,
  })
}

const AI_MODEL = process.env.AI_MODEL ?? 'gpt-4o'

export interface AlertExplanation {
  summary: string
  probable_cause: string
  recommended_action: string
}

export async function explainAlert(params: {
  metric: string
  baseline_ms: number
  observed_ms: number
  deviation_pct: number
  operation?: string
  slope_ms_per_hour?: number
}): Promise<AlertExplanation | null> {
  if (!process.env.OPENAI_API_KEY) return null

  const prompt = `You are an observability expert analyzing a performance anomaly alert.

Alert details:
- Metric: ${params.metric}
- Baseline (expected): ${params.baseline_ms.toFixed(1)} ms
- Observed: ${params.observed_ms.toFixed(1)} ms
- Deviation: +${params.deviation_pct.toFixed(1)}% above baseline
${params.operation ? `- Operation: ${params.operation}` : ''}
${params.slope_ms_per_hour !== undefined ? `- Trend slope: +${params.slope_ms_per_hour.toFixed(1)} ms/hour (increasing)` : ''}

Provide a concise JSON response with three keys:
- "summary": One sentence describing what happened (≤20 words)
- "probable_cause": Most likely root cause (≤30 words)
- "recommended_action": Concrete next step for an engineer (≤25 words)

Respond with raw JSON only, no markdown.`

  try {
    const response = await getClient().chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    })

    const text = response.choices[0]?.message?.content
    if (!text) return null
    return JSON.parse(text) as AlertExplanation
  } catch {
    return null
  }
}
