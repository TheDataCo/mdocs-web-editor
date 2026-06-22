// AI markdown conversion via OpenRouter. Turns raw tool output — logs, JSON,
// CSV, HTML, terminal dumps, scraped text — into clean GitHub-flavored Markdown.
// Server-side so the OpenRouter key never reaches end-user machines.
import { env } from './env.js'

export class LlmError extends Error {
  constructor(
    public code: 'ai_unavailable' | 'ai_failed',
    message: string,
  ) {
    super(message)
  }
}

// Bound cost/latency: anything bigger is rejected rather than silently truncated.
const MAX_INPUT_CHARS = 100_000

const SYSTEM_PROMPT = `You convert raw tool output — logs, JSON, CSV, HTML, terminal dumps, scraped text — into clean, well-structured GitHub-flavored Markdown.

Rules:
- Preserve all information. Never invent content, and don't summarize away or drop anything unless explicitly told to.
- Pick the markdown structure that best fits the data: headings, tables, lists, fenced code blocks (with a language hint), blockquotes.
- Keep verbatim content (commands, ids, paths, stack traces) inside code spans or fenced blocks.
- Output ONLY the markdown. No preamble, no commentary, and do not wrap the whole document in a code fence.`

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

export async function convertToMarkdown(text: string, hint?: string): Promise<string> {
  const key = env.OPENROUTER_API_KEY
  if (!key) throw new LlmError('ai_unavailable', 'AI conversion is not configured on this server.')
  if (text.length > MAX_INPUT_CHARS) {
    throw new LlmError('ai_failed', `Input too large (${text.length} chars; max ${MAX_INPUT_CHARS}).`)
  }

  const userContent = hint ? `Guidance: ${hint}\n\nRaw input:\n${text}` : text

  let res: Response
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers (shown in their dashboard).
        'HTTP-Referer': 'https://mdocs.datacompany.dev',
        'X-Title': 'mdocs',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    })
  } catch (e) {
    throw new LlmError('ai_failed', `Could not reach OpenRouter: ${(e as Error).message}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new LlmError('ai_failed', `OpenRouter error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const data = (await res.json().catch(() => null)) as ChatCompletion | null
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new LlmError('ai_failed', 'OpenRouter returned no content.')
  return stripWrappingFence(content.trim())
}

// Models sometimes wrap the whole document in ```markdown … ``` despite the
// instruction not to; unwrap a single outer fence if that's all there is.
function stripWrappingFence(s: string): string {
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return m?.[1] ?? s
}
