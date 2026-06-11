import { type CommentValue, DOC_COMMENTS_FIELD, DOC_TEXT_FIELD } from '@mdocs/core'
import type { EditorView } from 'codemirror'
import { useEffect, useState } from 'react'
import * as Y from 'yjs'

const enc = (r: Y.RelativePosition) => btoa(String.fromCharCode(...Y.encodeRelativePosition(r)))
const dec = (s: string) => Y.decodeRelativePosition(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export function CommentsPanel({
  doc,
  view,
  displayName,
  onClose,
}: {
  doc: Y.Doc
  view: EditorView | null
  displayName: string
  onClose: () => void
}) {
  const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
  const [comments, setComments] = useState<CommentValue[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')

  useEffect(() => {
    const update = () => setComments([...ymap.values()])
    update()
    ymap.observe(update)
    return () => ymap.unobserve(update)
  }, [doc]) // eslint-disable-line react-hooks/exhaustive-deps

  function add(body: string, parentId: string | null) {
    if (!body.trim()) return
    const ytext = doc.getText(DOC_TEXT_FIELD)
    let anchorStart: string | null = null
    let anchorEnd: string | null = null
    let excerpt = ''
    const sel = view?.state.selection.main
    if (!parentId && sel && !sel.empty) {
      anchorStart = enc(Y.createRelativePositionFromTypeIndex(ytext, sel.from))
      anchorEnd = enc(Y.createRelativePositionFromTypeIndex(ytext, sel.to))
      excerpt = view!.state.sliceDoc(sel.from, sel.to).slice(0, 160)
    }
    const id = crypto.randomUUID()
    ymap.set(id, {
      id,
      authorId: null,
      authorName: displayName,
      body: body.trim(),
      anchorStart,
      anchorEnd,
      excerpt,
      parentId,
      status: 'open',
      resolvedBy: null,
      createdAt: Date.now(),
      resolvedAt: null,
    })
  }

  function setStatus(c: CommentValue, status: 'open' | 'resolved') {
    ymap.set(c.id, { ...c, status, resolvedAt: status === 'resolved' ? Date.now() : null })
  }

  function scrollToAnchor(c: CommentValue) {
    if (!c.anchorStart || !view) return
    const start = Y.createAbsolutePositionFromRelativePosition(dec(c.anchorStart), doc)
    const end = c.anchorEnd ? Y.createAbsolutePositionFromRelativePosition(dec(c.anchorEnd), doc) : null
    if (!start) return
    view.dispatch({ selection: { anchor: start.index, head: end?.index ?? start.index }, scrollIntoView: true })
    view.focus()
  }

  const roots = comments
    .filter((c) => !c.parentId && (showResolved || c.status === 'open'))
    .sort((a, b) => a.createdAt - b.createdAt)
  const repliesOf = (id: string) =>
    comments.filter((c) => c.parentId === id).sort((a, b) => a.createdAt - b.createdAt)
  const openCount = comments.filter((c) => !c.parentId && c.status === 'open').length

  return (
    <aside className="comments-panel">
      <div className="comments-head">
        <span className="comments-title">Comments {openCount > 0 && <em>({openCount})</em>}</span>
        <label className="comments-toggle">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> resolved
        </label>
        <button className="icon-btn" onClick={onClose} aria-label="Close comments">
          ✕
        </button>
      </div>

      <div className="comments-new">
        <textarea
          placeholder="Comment on the selected text (or the doc)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn primary"
          disabled={!draft.trim()}
          onClick={() => {
            add(draft, null)
            setDraft('')
          }}
        >
          Comment
        </button>
      </div>

      <div className="comments-list">
        {roots.length === 0 && <p className="muted">No comments yet.</p>}
        {roots.map((c) => (
          <div key={c.id} className={`comment ${c.status}`}>
            {c.excerpt && (
              <button className="comment-excerpt" onClick={() => scrollToAnchor(c)} title="Jump to text">
                “{c.excerpt}”
              </button>
            )}
            <div className="comment-meta">
              <strong>{c.authorName ?? 'Someone'}</strong>
              <span className="muted">{new Date(c.createdAt).toLocaleString()}</span>
            </div>
            <div className="comment-body">{c.body}</div>
            {repliesOf(c.id).map((r) => (
              <div key={r.id} className="comment-reply">
                <div className="comment-meta">
                  <strong>{r.authorName ?? 'Someone'}</strong>
                </div>
                <div className="comment-body">{r.body}</div>
              </div>
            ))}
            <div className="comment-actions">
              <button onClick={() => setStatus(c, c.status === 'open' ? 'resolved' : 'open')}>
                {c.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
              <button onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>Reply</button>
            </div>
            {replyTo === c.id && (
              <div className="comments-new">
                <textarea value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder="Reply…" />
                <button
                  className="btn"
                  disabled={!replyDraft.trim()}
                  onClick={() => {
                    add(replyDraft, c.id)
                    setReplyDraft('')
                    setReplyTo(null)
                  }}
                >
                  Reply
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
