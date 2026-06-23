import type { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { aiAssist } from '../api'

// What invoked the assistant and where to apply the result.
//  - menu: the "/" slash menu is open (rendered by the editor, not this panel)
//  - ask/write: generate text to insert below the cursor (doc untouched)
//  - doc: rewrite the whole document (preview, then replace on accept)
//  - selection: rewrite the highlighted range (preview, then replace on accept)
export type AiTrigger =
  | { kind: 'menu'; x: number; y: number; at: number }
  | { kind: 'ask'; x: number; y: number; at: number }
  | { kind: 'write'; x: number; y: number; at: number }
  | { kind: 'doc'; x: number; y: number }
  | { kind: 'selection'; x: number; y: number; from: number; to: number; text: string }

export type AiPanelTrigger = Exclude<AiTrigger, { kind: 'menu' }>

// One-tap rewrites for a highlighted selection.
const QUICK: [string, string][] = [
  ['Improve writing', 'Improve the writing — clarity, flow, and grammar — without changing the meaning.'],
  ['Fix grammar', 'Fix spelling and grammar only; keep wording otherwise.'],
  ['Make concise', 'Make this more concise while keeping all key information.'],
  ['Format nicely', 'Reformat this into clean, well-structured Markdown.'],
]

function placeholderFor(kind: AiPanelTrigger['kind']): string {
  if (kind === 'ask') return 'Ask a question…'
  if (kind === 'write') return 'Describe what to write…'
  if (kind === 'doc') return 'How should I rewrite the document?'
  return 'How should I change this?'
}

export function AiAssist({
  view,
  trigger,
  docText,
  onClose,
}: {
  view: EditorView
  trigger: AiPanelTrigger
  docText: string
  onClose: () => void
}) {
  const [instruction, setInstruction] = useState('')
  const [stage, setStage] = useState<'input' | 'loading' | 'preview'>('input')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const isRewrite = trigger.kind === 'doc' || trigger.kind === 'selection'

  async function run(instr: string) {
    const text = instr.trim()
    if (!text) return
    setStage('loading')
    setError(null)
    try {
      const output = await aiAssist(
        trigger.kind === 'selection'
          ? { mode: 'rewrite', instruction: text, selection: trigger.text }
          : trigger.kind === 'doc'
            ? { mode: 'rewrite', instruction: text, document: docText }
            : { mode: 'generate', instruction: text, document: docText },
      )
      setResult(output)
      setStage('preview')
    } catch (e) {
      setError((e as Error).message)
      setStage('input')
    }
  }

  // Apply the result through view.dispatch so the change flows into Yjs and out
  // to collaborators. Offsets are clamped — the doc may have shifted underneath us.
  function accept() {
    const len = view.state.doc.length
    if (trigger.kind === 'selection') {
      const from = Math.min(trigger.from, len)
      const to = Math.min(trigger.to, len)
      view.dispatch({ changes: { from, to, insert: result }, selection: { anchor: from + result.length } })
    } else if (trigger.kind === 'doc') {
      view.dispatch({ changes: { from: 0, to: len, insert: result } })
    } else {
      // ask / write: insert below the current line, leaving existing text intact.
      const at = Math.min(view.state.selection.main.head, len)
      const line = view.state.doc.lineAt(at)
      const insert = `\n\n${result}`
      view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } })
    }
    view.focus()
    onClose()
  }

  const top = Math.min(trigger.y + 6, window.innerHeight - 240)
  const left = Math.min(trigger.x, window.innerWidth - 372)

  return (
    <div className="ai-panel" style={{ top, left }} onClick={(e) => e.stopPropagation()}>
      {stage !== 'preview' ? (
        <>
          <textarea
            ref={inputRef}
            className="ai-input"
            rows={2}
            placeholder={placeholderFor(trigger.kind)}
            value={instruction}
            disabled={stage === 'loading'}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                run(instruction)
              }
            }}
          />
          {trigger.kind === 'selection' && stage === 'input' && (
            <div className="ai-chips">
              {QUICK.map(([label, instr]) => (
                <button key={label} type="button" className="ai-chip" onClick={() => run(instr)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="ai-actions">
            <span className="muted ai-hint">{stage === 'loading' ? 'Thinking…' : 'Enter to run · Esc to close'}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn primary"
              disabled={stage === 'loading' || !instruction.trim()}
              onClick={() => run(instruction)}
            >
              {isRewrite ? 'Rewrite' : 'Generate'}
            </button>
          </div>
          {error && <div className="ai-error">{error}</div>}
        </>
      ) : (
        <>
          <div className="ai-preview">{result}</div>
          <div className="ai-actions">
            <button type="button" className="btn" onClick={() => setStage('input')}>
              Try again
            </button>
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Discard
            </button>
            <button type="button" className="btn primary" onClick={accept}>
              {trigger.kind === 'selection' ? 'Replace' : trigger.kind === 'doc' ? 'Replace document' : 'Insert'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
