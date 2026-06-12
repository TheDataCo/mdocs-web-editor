import { type CommentValue, DOC_COMMENTS_FIELD, DOC_TEXT_FIELD } from '@mdocs/core'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { decodeAnchor, encodeAnchor } from '../lib/anchors'
import { findDomRange, findSourceRange } from '../lib/sourceMatch'

// Google-Docs-style comments over the read-mode preview: anchored text is
// painted via the CSS Custom Highlight API (no DOM mutation under React),
// and comment cards sit in a right margin, pushed apart so they never overlap.

interface Pending {
  from: number // source offsets; -1 when the selection couldn't be mapped
  to: number
  excerpt: string
  desiredTop: number
}

const GAP = 10
const TOP_PAD = 12
const AVATAR_COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ee6352', '#9ac2c9', '#8acb88', '#e36397']

function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length] ?? '#9ac2c9'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? `${time} Today`
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

// CSS Custom Highlight API isn't in the TS lib everywhere yet; feature-detect.
function setHighlight(name: string, ranges: Range[]) {
  const Hl = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!Hl || !registry) return
  if (ranges.length) registry.set(name, new Hl(...ranges))
  else registry.delete(name)
}

function clearHighlights() {
  setHighlight('mdocs-comment', [])
  setHighlight('mdocs-comment-active', [])
  setHighlight('mdocs-comment-resolved', [])
}

function shallowEq(a: Record<string, number | null>, b: Record<string, number | null>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}

export function CommentMargin({
  doc,
  text,
  paneRef,
  contentRef,
  displayName,
  avatarUrl,
  showResolved,
  onHasComments,
}: {
  doc: Y.Doc
  text: string
  paneRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  displayName: string
  avatarUrl?: string
  showResolved: boolean
  onHasComments: (has: boolean) => void
}) {
  const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
  const [comments, setComments] = useState<CommentValue[]>([])
  const [fabTop, setFabTop] = useState<number | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [draft, setDraft] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [desired, setDesired] = useState<Record<string, number | null>>({})
  const [tops, setTops] = useState<Record<string, number | null>>({})
  const [tick, setTick] = useState(0)
  const rangesRef = useRef(new Map<string, Range>())
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const draftRef = useRef('')
  draftRef.current = draft
  const pendingRef = useRef<Pending | null>(null)
  pendingRef.current = pending

  useEffect(() => {
    const update = () => setComments([...ymap.values()])
    update()
    ymap.observe(update)
    return () => ymap.unobserve(update)
  }, [doc]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearHighlights, [])

  const roots = comments
    .filter((c) => !c.parentId && (showResolved || c.status === 'open'))
    .sort((a, b) => a.createdAt - b.createdAt)
  const repliesOf = (id: string) =>
    comments.filter((c) => c.parentId === id).sort((a, b) => a.createdAt - b.createdAt)

  useEffect(() => {
    onHasComments(roots.length > 0 || pending !== null)
  }, [roots.length, pending, onHasComments])

  // Re-anchor when the rendered content reflows (window resize, images, fonts).
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(content)
    return () => ro.disconnect()
  }, [contentRef])

  // Map each visible comment's Yjs anchor → source offsets → preview DOM range,
  // paint the highlights, and record where each card wants to sit.
  useLayoutEffect(() => {
    const pane = paneRef.current
    const content = contentRef.current
    if (!pane || !content) return
    const paneRect = pane.getBoundingClientRect()
    const ranges = new Map<string, Range>()
    const next: Record<string, number | null> = {}
    const open: Range[] = []
    const active: Range[] = []
    const resolved: Range[] = []
    for (const c of roots) {
      let r: Range | null = null
      if (c.anchorStart && c.anchorEnd) {
        const s = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorStart), doc)
        const e = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorEnd), doc)
        if (s && e && e.index > s.index && e.index <= text.length) r = findDomRange(content, text, s.index, e.index)
      }
      if (r) {
        ranges.set(c.id, r)
        next[c.id] = r.getBoundingClientRect().top - paneRect.top + pane.scrollTop
        if (c.status === 'resolved') resolved.push(r)
        else if (c.id === activeId) active.push(r)
        else open.push(r)
      } else {
        next[c.id] = null
      }
    }
    if (pending && pending.from >= 0 && pending.to <= text.length) {
      const r = findDomRange(content, text, pending.from, pending.to)
      if (r) active.push(r)
    }
    rangesRef.current = ranges
    setHighlight('mdocs-comment', open)
    setHighlight('mdocs-comment-active', active)
    setHighlight('mdocs-comment-resolved', resolved)
    setDesired((prev) => (shallowEq(prev, next) ? prev : next))
  }, [comments, text, showResolved, pending, activeId, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stack the cards: each sits at its highlight's height unless a card above
  // pushes it down. Runs after every render so height changes re-flow.
  useLayoutEffect(() => {
    const items: { id: string; want: number }[] = []
    if (pending) items.push({ id: '__draft', want: pending.desiredTop })
    for (const c of roots) items.push({ id: c.id, want: desired[c.id] ?? TOP_PAD })
    items.sort((a, b) => a.want - b.want)
    let y = TOP_PAD
    const next: Record<string, number> = {}
    for (const it of items) {
      const top = Math.max(it.want, y)
      next[it.id] = top
      y = top + (cardEls.current.get(it.id)?.offsetHeight ?? 90) + GAP
    }
    setTops((prev) => (shallowEq(prev, next) ? prev : next))
  })

  // Selection → floating "add comment" bubble next to the text column.
  useEffect(() => {
    function place() {
      const sel = document.getSelection()
      const content = contentRef.current
      const pane = paneRef.current
      if (!sel || sel.isCollapsed || !content || !pane) return setFabTop(null)
      const range = sel.getRangeAt(0)
      if (!content.contains(range.commonAncestorContainer)) return setFabTop(null)
      const rect = range.getBoundingClientRect()
      const paneRect = pane.getBoundingClientRect()
      setFabTop(rect.top - paneRect.top + pane.scrollTop)
    }
    const onMouseUp = () => setTimeout(place, 0)
    function onSelChange() {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed) setFabTop(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelChange)
    }
  }, [contentRef, paneRef])

  // Click on a highlight focuses its card; click elsewhere clears focus (and
  // discards an empty composer).
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (t.closest('.comment-card') || t.closest('.comment-fab')) return
      let node: Node | null = null
      let off = 0
      const d = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      if (d.caretRangeFromPoint) {
        const r = d.caretRangeFromPoint(e.clientX, e.clientY)
        if (r) (node = r.startContainer), (off = r.startOffset)
      } else if (d.caretPositionFromPoint) {
        const p = d.caretPositionFromPoint(e.clientX, e.clientY)
        if (p) (node = p.offsetNode), (off = p.offset)
      }
      let hit: string | null = null
      if (node) {
        for (const [cid, range] of rangesRef.current) {
          try {
            if (range.isPointInRange(node, off)) {
              hit = cid
              break
            }
          } catch {
            // stale range from a previous render — ignore
          }
        }
      }
      setActiveId(hit)
      setMenuId(null)
      if (!hit && pendingRef.current && !draftRef.current.trim()) setPending(null)
    }
    pane.addEventListener('click', onClick)
    return () => pane.removeEventListener('click', onClick)
  }, [paneRef])

  // mousedown (not click) so the browser doesn't clear the selection first.
  function startCompose(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const sel = document.getSelection()
    const pane = paneRef.current
    if (!sel || sel.isCollapsed || !pane) return
    const selText = sel.toString()
    const range = sel.getRangeAt(0)
    const startEl =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    const hintLine = Number(startEl?.closest('[data-line]')?.getAttribute('data-line')) || 1
    const source = doc.getText(DOC_TEXT_FIELD).toString()
    const match = findSourceRange(source, selText, hintLine)
    const rect = range.getBoundingClientRect()
    const paneRect = pane.getBoundingClientRect()
    setPending({
      from: match?.from ?? -1,
      to: match?.to ?? -1,
      excerpt: selText.replace(/\s+/g, ' ').trim().slice(0, 160),
      desiredTop: rect.top - paneRect.top + pane.scrollTop,
    })
    setDraft('')
    setActiveId(null)
    setFabTop(null)
    sel.removeAllRanges()
  }

  function submitComment() {
    const body = draft.trim()
    if (!body || !pending) return
    const ytext = doc.getText(DOC_TEXT_FIELD)
    const anchored = pending.from >= 0 && pending.to > pending.from && pending.to <= ytext.length
    const id = crypto.randomUUID()
    ymap.set(id, {
      id,
      authorId: null,
      authorName: displayName,
      body,
      anchorStart: anchored ? encodeAnchor(Y.createRelativePositionFromTypeIndex(ytext, pending.from)) : null,
      anchorEnd: anchored ? encodeAnchor(Y.createRelativePositionFromTypeIndex(ytext, pending.to)) : null,
      excerpt: pending.excerpt,
      parentId: null,
      status: 'open',
      resolvedBy: null,
      createdAt: Date.now(),
      resolvedAt: null,
    })
    setPending(null)
    setDraft('')
    setActiveId(id)
  }

  function submitReply(parent: CommentValue) {
    const body = replyDraft.trim()
    if (!body) return
    const id = crypto.randomUUID()
    ymap.set(id, {
      id,
      authorId: null,
      authorName: displayName,
      body,
      anchorStart: null,
      anchorEnd: null,
      excerpt: '',
      parentId: parent.id,
      status: 'open',
      resolvedBy: null,
      createdAt: Date.now(),
      resolvedAt: null,
    })
    setReplyDraft('')
  }

  function setStatus(c: CommentValue, status: 'open' | 'resolved') {
    ymap.set(c.id, { ...c, status, resolvedAt: status === 'resolved' ? Date.now() : null })
    if (status === 'resolved' && activeId === c.id) setActiveId(null)
  }

  function remove(c: CommentValue) {
    doc.transact(() => {
      for (const r of comments) if (r.parentId === c.id) ymap.delete(r.id)
      ymap.delete(c.id)
    })
  }

  const hasCards = roots.length > 0 || pending !== null
  const cardRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardEls.current.set(id, el)
    else cardEls.current.delete(id)
  }

  return (
    <>
      {fabTop !== null && !pending && (
        <button
          className="comment-fab"
          style={{ top: fabTop }}
          onMouseDown={startCompose}
          title="Add comment"
          aria-label="Add comment"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M12 7v6M9 10h6" />
          </svg>
        </button>
      )}
      {hasCards && <div className="comment-rail" />}
      {hasCards && (
        <div className="comment-margin">
          {pending && (
            <div
              className="comment-card composer active"
              style={{ top: tops['__draft'] ?? pending.desiredTop }}
              ref={cardRef('__draft')}
            >
              <div className="comment-head">
                {avatarUrl ? (
                  <img className="comment-avatar" src={avatarUrl} alt="" />
                ) : (
                  <span className="comment-avatar initials" style={{ background: avatarColor(displayName) }}>
                    {displayName.charAt(0)}
                  </span>
                )}
                <div className="comment-who">
                  <span className="comment-name">{displayName}</span>
                </div>
              </div>
              <input
                className="comment-input"
                autoFocus
                placeholder="Add a comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitComment()
                  if (e.key === 'Escape') setPending(null)
                }}
              />
              <div className="comment-btns">
                <button className="btn" onClick={() => setPending(null)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={!draft.trim()} onClick={submitComment}>
                  Comment
                </button>
              </div>
            </div>
          )}
          {roots.map((c) => {
            const isActive = activeId === c.id
            return (
              <div
                key={c.id}
                className={`comment-card ${c.status === 'resolved' ? 'resolved' : ''} ${isActive ? 'active' : ''}`}
                style={{ top: tops[c.id] ?? desired[c.id] ?? TOP_PAD }}
                ref={cardRef(c.id)}
                onClick={() => setActiveId(c.id)}
              >
                <div className="comment-head">
                  <span className="comment-avatar initials" style={{ background: avatarColor(c.authorName ?? '?') }}>
                    {(c.authorName ?? '?').charAt(0)}
                  </span>
                  <div className="comment-who">
                    <span className="comment-name">{c.authorName ?? 'Someone'}</span>
                    <span className="comment-time">
                      {fmtTime(c.createdAt)}
                      {c.status === 'resolved' ? ' · Resolved' : ''}
                    </span>
                  </div>
                  <div className="comment-tools" onClick={(e) => e.stopPropagation()}>
                    <div className="comment-menu-wrap">
                      <button
                        className="icon-btn"
                        aria-label="More actions"
                        onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                      >
                        ⋮
                      </button>
                      {menuId === c.id && (
                        <div className="menu">
                          {c.status === 'resolved' && (
                            <button
                              onClick={() => {
                                setStatus(c, 'open')
                                setMenuId(null)
                              }}
                            >
                              Reopen
                            </button>
                          )}
                          <button
                            className="danger"
                            onClick={() => {
                              setMenuId(null)
                              remove(c)
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {desired[c.id] === null && c.excerpt && <div className="comment-quote">“{c.excerpt}”</div>}
                <div className="comment-body">{c.body}</div>
                {repliesOf(c.id).map((r) => (
                  <div key={r.id} className="comment-reply">
                    <div className="comment-head">
                      <span
                        className="comment-avatar initials"
                        style={{ background: avatarColor(r.authorName ?? '?') }}
                      >
                        {(r.authorName ?? '?').charAt(0)}
                      </span>
                      <div className="comment-who">
                        <span className="comment-name">{r.authorName ?? 'Someone'}</span>
                        <span className="comment-time">{fmtTime(r.createdAt)}</span>
                      </div>
                    </div>
                    <div className="comment-body">{r.body}</div>
                  </div>
                ))}
                {isActive && c.status === 'open' && (
                  <input
                    className="comment-input"
                    placeholder="Reply"
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitReply(c)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                {c.status === 'open' && (
                  <div className="comment-foot">
                    <button
                      className="comment-resolve"
                      title="Mark as resolved and hide discussion"
                      onClick={(e) => {
                        e.stopPropagation()
                        setStatus(c, 'resolved')
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
