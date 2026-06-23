// AI features via OpenRouter — markdown conversion (`/api/convert`) and the
// in-editor assistant (`/api/ai`). Server-side so the OpenRouter key never
// reaches end-user machines.
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

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

// Single place that talks to OpenRouter. Throws LlmError on any failure.
async function chat(messages: ChatMessage[]): Promise<string> {
  const key = env.OPENROUTER_API_KEY
  if (!key) throw new LlmError('ai_unavailable', 'AI is not configured on this server.')

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
      body: JSON.stringify({ model: env.OPENROUTER_MODEL, messages }),
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

const CONVERT_SYSTEM = `You convert raw tool output — logs, JSON, CSV, HTML, terminal dumps, scraped text — into clean, well-structured GitHub-flavored Markdown.

Rules:
- Preserve all information. Never invent content, and don't summarize away or drop anything unless explicitly told to.
- Pick the markdown structure that best fits the data: headings, tables, lists, fenced code blocks (with a language hint), blockquotes.
- Keep verbatim content (commands, ids, paths, stack traces) inside code spans or fenced blocks.
- Output ONLY the markdown. No preamble, no commentary, and do not wrap the whole document in a code fence.`

export async function convertToMarkdown(text: string, hint?: string): Promise<string> {
  if (text.length > MAX_INPUT_CHARS) {
    throw new LlmError('ai_failed', `Input too large (${text.length} chars; max ${MAX_INPUT_CHARS}).`)
  }
  const userContent = hint ? `Guidance: ${hint}\n\nRaw input:\n${text}` : text
  return chat([
    { role: 'system', content: CONVERT_SYSTEM },
    { role: 'user', content: userContent },
  ])
}

// 'generate' produces new markdown to insert (answering a question or writing a
// passage); 'rewrite' transforms the supplied selection and returns a drop-in
// replacement for it.
export type AssistMode = 'generate' | 'rewrite'

const GENERATE_SYSTEM = `You are a writing assistant embedded in a live Markdown document editor. The user gives an instruction or question; you respond with GitHub-flavored Markdown that will be inserted directly into their document at the cursor.

Rules:
- Output ONLY the content to insert — no preamble like "Sure" or "Here is", no commentary, and no outer code fence.
- Answer questions concisely and factually. For writing requests, produce well-structured prose/markdown.
- You may be given the current document as context; use it to stay consistent, but only output the new content.`

const REWRITE_SYSTEM = `You are an editing assistant inside a live Markdown document editor. You are given a snippet of the document and an instruction. Rewrite or reformat the snippet according to the instruction.

Rules:
- Output ONLY the replacement markdown for that snippet — no preamble, no commentary, no outer code fence.
- Preserve the original meaning and information unless the instruction explicitly asks otherwise.
- Keep formatting idiomatic GitHub-flavored Markdown.`

export async function runAssist(opts: {
  mode: AssistMode
  instruction: string
  selection?: string
  document?: string
}): Promise<string> {
  const { mode, instruction, selection, document } = opts
  if ((selection?.length ?? 0) > MAX_INPUT_CHARS || (document?.length ?? 0) > MAX_INPUT_CHARS) {
    throw new LlmError('ai_failed', `Input too large (max ${MAX_INPUT_CHARS} chars).`)
  }

  if (mode === 'rewrite') {
    const snippet = selection ?? document ?? ''
    return chat([
      { role: 'system', content: REWRITE_SYSTEM },
      { role: 'user', content: `Instruction: ${instruction}\n\nSnippet to rewrite:\n${snippet}` },
    ])
  }

  // generate
  const context = document ? `\n\nCurrent document (for context only — do not repeat it):\n${document}` : ''
  const sel = selection ? `\n\nThe user has this text selected:\n${selection}` : ''
  return chat([
    { role: 'system', content: GENERATE_SYSTEM },
    { role: 'user', content: `${instruction}${sel}${context}` },
  ])
}

// Models sometimes wrap the whole document in ```markdown … ``` despite the
// instruction not to; unwrap a single outer fence if that's all there is.
function stripWrappingFence(s: string): string {
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return m?.[1] ?? s
}
