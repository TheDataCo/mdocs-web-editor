import { useUser } from '@clerk/clerk-react'
import { UserMenu } from '../components/UserMenu'
import { indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { indentUnit } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { DocMeta } from '@mdocs/core'
import { DOC_COMMENTS_FIELD, DOC_TEXT_FIELD } from '@mdocs/core'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import {
  createLink,
  deleteDoc,
  type DocVersion,
  getDoc,
  getVersionContent,
  listVersions,
  redeemLink,
  renameDoc,
  setFavorite,
  shareDoc,
} from '../api'
import { getToken } from '../auth'
import { AiAssist, type AiTrigger } from '../components/AiAssist'
import { DocTree } from '../components/DocTree'
import { WS_URL } from '../config'
import { CommentMargin } from '../components/CommentMargin'
import { commentHighlightField, computeCommentMarks, setCommentMarks } from '../lib/commentDecorations'
import { Preview } from './Preview'

// 'split' = source + live preview side by side (editing); 'preview' = single
// rendered reading pane.
type Mode = 'split' | 'preview'
interface Peer {
  name: string
  color: string
}

const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ee6352', '#9ac2c9', '#8acb88', '#e36397']
const NAMES = ['Ada', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Alan']

export function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [canEdit, setCanEdit] = useState<boolean | null>(null) // null = still loading access
  const [status, setStatus] = useState('connecting')
  const [text, setText] = useState('')
  const [peers, setPeers] = useState<Peer[]>([])
  const [shareOpen, setShareOpen] = useState(false)
  const [copied, setCopied] = useState<'viewer' | 'editor' | null>(null)
  const [docCopied, setDocCopied] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(`mdocs:view:${id}`) === 'preview' ? 'preview' : 'split',
  )
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem('mdocs:sidebar') === '1')
  const [previewCollapsed, setPreviewCollapsed] = useState(() => localStorage.getItem('mdocs:preview') === '1')
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [hasComments, setHasComments] = useState(false)
  const [favorite, setFavoriteState] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions, setVersions] = useState<DocVersion[] | null>(null)
  const [viewingVersion, setViewingVersion] = useState<{ n: number; content: string } | null>(null)
  // AI assistant: the "/" slash menu / prompt panel, and the floating "Ask AI"
  // button that appears over a non-empty selection.
  const [ai, setAi] = useState<AiTrigger | null>(null)
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; from: number; to: number; text: string } | null>(null)
  const navigate = useNavigate()
  const { user } = useUser()
  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Someone'

  function toggleTree() {
    setTreeCollapsed((v) => {
      localStorage.setItem('mdocs:sidebar', v ? '0' : '1')
      return !v
    })
  }
  function togglePreview() {
    setPreviewCollapsed((v) => {
      localStorage.setItem('mdocs:preview', v ? '0' : '1')
      return !v
    })
  }

  const editorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewInnerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const modeRef = useRef(mode)
  const titleSaveRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toggleRef = useRef(() => {})
  toggleRef.current = () => setMode(modeRef.current === 'preview' ? 'split' : 'preview')
  const previewToggleRef = useRef(() => {})
  previewToggleRef.current = togglePreview

  // Called from the "/" keymap. Opens the AI slash menu when the cursor is at a
  // line start or just after whitespace (so "/" still types normally elsewhere).
  // Returns true to swallow the "/" when it opens the menu.
  const slashRef = useRef<(view: EditorView) => boolean>(() => false)
  slashRef.current = (view) => {
    if (!canEdit) return false
    const sel = view.state.selection.main
    if (!sel.empty) return false
    const before = sel.from === 0 ? '' : view.state.doc.sliceString(sel.from - 1, sel.from)
    if (before !== '' && !/\s/.test(before)) return false
    const coords = view.coordsAtPos(sel.from)
    if (!coords) return false
    setSelBtn(null)
    setAi({ kind: 'menu', x: coords.left, y: coords.bottom, at: sel.from })
    return true
  }
  // Called on every selection change. Shows/hides the floating "Ask AI" button.
  const selRef = useRef<(view: EditorView) => void>(() => {})
  selRef.current = (view) => {
    const clear = () => setSelBtn((cur) => (cur ? null : cur))
    const sel = view.state.selection.main
    if (sel.empty || !canEdit) return clear()
    const text = view.state.doc.sliceString(sel.from, sel.to)
    if (!text.trim()) return clear()
    const coords = view.coordsAtPos(sel.to)
    if (!coords) return clear()
    setSelBtn({ x: coords.left, y: coords.bottom, from: sel.from, to: sel.to, text })
  }

  // Load access: redeem a share link if present in the URL, then fetch the doc
  // + the caller's edit permission. Gate the editor build on this completing.
  useEffect(() => {
    let cancelled = false
    // Reset on navigation so the previous doc doesn't flash while the new one loads.
    setMeta(null)
    setText('')
    setCanEdit(null)
    setHistoryOpen(false)
    setViewingVersion(null)
    ;(async () => {
      const share = new URLSearchParams(window.location.search).get('share')
      if (share) {
        await redeemLink(id!, share)
        window.history.replaceState({}, '', `/d/${id}`)
      }
      try {
        const d = await getDoc(id!)
        if (cancelled) return
        setMeta(d)
        setCanEdit(d.canEdit)
        setFavoriteState(d.favorite)
        if (!d.canEdit && localStorage.getItem(`mdocs:view:${id}`) !== 'split') setMode('preview')
      } catch {
        if (cancelled) return
        setMeta({ id: id!, title: 'Unknown doc', workspaceId: null, createdAt: '', updatedAt: '' })
        setCanEdit(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  function onTitleChange(title: string) {
    setMeta((m) => (m ? { ...m, title } : m))
    clearTimeout(titleSaveRef.current)
    titleSaveRef.current = setTimeout(() => {
      if (title.trim()) renameDoc(id!, title.trim()).catch(() => {})
    }, 500)
  }

  async function onInviteEmail(email: string) {
    if (!email.trim()) return
    const { status } = await shareDoc(id!, email.trim())
    setInviteMsg(status === 'shared' ? `Shared with ${email}` : `No mdocs account for ${email} yet`)
  }

  async function onCopyLink(role: 'viewer' | 'editor') {
    const token = await createLink(id!, role)
    await navigator.clipboard?.writeText(`${window.location.origin}/d/${id}?share=${token}`).catch(() => {})
    setCopied(role)
    setTimeout(() => setCopied((c) => (c === role ? null : c)), 1800)
  }

  // Build the collaborative editor once access is known (read-only for viewers).
  useEffect(() => {
    if (canEdit === null) return
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: id!,
      token: getToken,
      document: doc,
      onStatus({ status }) {
        setStatus(status)
      },
    })

    setYdoc(doc)
    const ytext = doc.getText(DOC_TEXT_FIELD)
    const undoManager = new Y.UndoManager(ytext)
    const awareness = provider.awareness!
    awareness.setLocalStateField('user', {
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })
    const updatePeers = () => {
      const seen = new Map<string, Peer>()
      for (const [clientId, s] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue // skip yourself
        if (s.user) seen.set(`${s.user.name}|${s.user.color}`, s.user as Peer)
      }
      setPeers([...seen.values()])
    }
    awareness.on('change', updatePeers)
    updatePeers()

    const view = new EditorView({
      extensions: [
        keymap.of([
          {
            key: 'Mod-e',
            run: () => {
              toggleRef.current()
              return true
            },
          },
          {
            key: 'Mod-p',
            preventDefault: true,
            run: () => {
              previewToggleRef.current()
              return true
            },
          },
          {
            key: '/',
            run: (v) => slashRef.current(v),
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) selRef.current(u.view)
        }),
        keymap.of(yUndoManagerKeymap),
        keymap.of([indentWithTab]), // Tab indents (4 spaces) — enables nested lists
        basicSetup,
        markdown(),
        indentUnit.of('    '),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!canEdit), // viewers can't type (server enforces too)
        commentHighlightField,
        yCollab(ytext, awareness, { undoManager }),
      ],
      parent: editorRef.current!,
    })
    viewRef.current = view

    const syncPreviewText = () => setText(ytext.toString())
    ytext.observe(syncPreviewText)
    provider.on('synced', syncPreviewText)

    // A blank doc always opens ready to type, whatever the saved view mode.
    let blankChecked = false
    const openBlankInEdit = () => {
      if (blankChecked) return
      blankChecked = true
      if (canEdit && ytext.toString().trim() === '') setMode('split')
    }
    provider.on('synced', openBlankInEdit)

    // Recompute comment highlights when comments change (and once after sync).
    // Deferred to a microtask: on initial load the comments Y.Map and the text
    // land in the same Yjs transaction, and if this observer runs before
    // yCollab has populated CodeMirror, dispatching ranges past the (still
    // empty) editor throws — aborting the text-load observer and leaving the
    // editor blank (Read mode, driven separately, still rendered). Deferring
    // runs it after the transaction settles; clamping + try/catch are belts.
    const commentsMap = doc.getMap(DOC_COMMENTS_FIELD)
    const refreshMarks = () =>
      queueMicrotask(() => {
        if (viewRef.current !== view) return
        try {
          view.dispatch({ effects: setCommentMarks.of(computeCommentMarks(doc, view.state.doc.length)) })
        } catch {
          /* a bad anchor must never break the editor */
        }
      })
    commentsMap.observe(refreshMarks)
    provider.on('synced', refreshMarks)

    return () => {
      awareness.off('change', updatePeers)
      commentsMap.unobserve(refreshMarks)
      ytext.unobserve(syncPreviewText)
      view.destroy()
      viewRef.current = null
      setYdoc(null)
      provider.destroy()
      doc.destroy()
    }
  }, [id, canEdit])

  useEffect(() => {
    modeRef.current = mode
    localStorage.setItem(`mdocs:view:${id}`, mode)
    if (mode === 'split') viewRef.current?.focus()
  }, [mode, id])

  // CodeMirror must re-measure when the panes resize (preview show/hide).
  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [previewCollapsed, treeCollapsed])

  // Close the share menu on any outside click.
  useEffect(() => {
    const close = () => {
      setShareOpen(false)
      setConfirmDelete(false)
      setAi(null)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  async function onDeleteDoc() {
    setShareOpen(false)
    setConfirmDelete(false)
    await deleteDoc(id!).catch(() => {})
    navigate('/')
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      // Don't hijack keystrokes while typing in an input/textarea (e.g. the title).
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        toggleRef.current()
        return
      }
      // Cmd/Ctrl+P toggles the preview pane (only meaningful in split mode).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'p' && modeRef.current === 'split') {
        e.preventDefault()
        previewToggleRef.current()
        return
      }
      // Only auto-jump to split for editors; viewers stay in read mode.
      if (modeRef.current !== 'preview' || !canEdit || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length === 1) {
        e.preventDefault()
        setMode('split')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit])

  function onToggleFavorite() {
    const next = !favorite
    setFavoriteState(next) // optimistic
    setFavorite(id!, next).catch(() => setFavoriteState(!next))
  }

  function openHistory() {
    setShareOpen(false)
    setHistoryOpen(true)
    setVersions(null)
    listVersions(id!).then(setVersions, () => setVersions([]))
  }

  async function onViewVersion(n: number) {
    const content = await getVersionContent(id!, n).catch(() => null)
    if (content !== null) setViewingVersion({ n, content })
  }

  async function onCopyDoc() {
    await navigator.clipboard?.writeText(text).catch(() => {})
    setDocCopied(true)
    setTimeout(() => setDocCopied(false), 1800)
  }

  function onPreviewDoubleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.comment-margin, .comment-fab')) return
    const view = viewRef.current
    const el = (e.target as HTMLElement).closest('[data-line]')
    if (view && el) {
      const line = Math.min(Number(el.getAttribute('data-line')) || 1, view.state.doc.lines)
      view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, scrollIntoView: true })
    }
    if (modeRef.current === 'preview' && canEdit) setMode('split')
  }

  return (
    <div className="editor-shell">
      {!treeCollapsed && <DocTree activeDocId={id} activeTitle={meta?.title} />}
      <div className="editor-main">
        <div className="topbar">
          <button className="icon-btn" onClick={toggleTree} title="Toggle sidebar" aria-label="Toggle sidebar">
            ☰
          </button>
          <input
            className="title-input"
            value={meta?.title ?? ''}
            placeholder="Untitled"
            onChange={(e) => onTitleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                clearTimeout(titleSaveRef.current)
                if (meta?.title.trim()) renameDoc(id!, meta.title.trim()).catch(() => {})
                e.currentTarget.blur()
              }
            }}
            readOnly={!canEdit}
            aria-label="Document title"
          />
          {canEdit === false && <span className="badge">View only</span>}
          <button
            className={`star ${favorite ? 'on' : ''}`}
            onClick={onToggleFavorite}
            title={favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            {favorite ? '★' : '☆'}
          </button>
          <span className="spacer" />
          <div className="peers">
            {peers.map((p) => (
              <span key={`${p.name}|${p.color}`} className="avatar" style={{ background: p.color }} title={p.name}>
                {p.name.charAt(0)}
              </span>
            ))}
          </div>
          <button className="btn" onClick={() => toggleRef.current()} title="Toggle view (Cmd+E)">
            {mode === 'preview' ? 'Edit' : 'Read'} <kbd>⌘E</kbd>
          </button>
          <button className="btn" onClick={onCopyDoc} title="Copy markdown">
            {docCopied ? 'Copied ✓' : 'Copy'}
          </button>
          <div className="share-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              className="icon-btn"
              onClick={() => {
                setShareOpen((o) => !o)
                setConfirmDelete(false)
              }}
              title="More"
              aria-label="More actions"
            >
              ⋯
            </button>
            {shareOpen && (
              <div className="menu share-menu">
                <button onClick={openHistory}>Version history</button>
                <button onClick={() => setShowResolved((v) => !v)}>
                  {showResolved ? 'Hide resolved comments' : 'Show resolved comments'}
                </button>
                {canEdit && (
                  <>
                    {/* Edit links only for now; read-only links stay supported in
                        the API + onCopyLink('viewer') for the future. */}
                    <button onClick={() => onCopyLink('editor')}>
                      {copied === 'editor' ? 'Copied ✓' : 'Copy link'}
                    </button>
                    <form
                      className="share-invite"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const input = e.currentTarget.elements.namedItem('email') as HTMLInputElement
                        onInviteEmail(input.value)
                        input.value = ''
                      }}
                    >
                      <input name="email" type="email" placeholder="Invite by email…" />
                    </form>
                    {inviteMsg && <div className="share-msg">{inviteMsg}</div>}
                    {confirmDelete ? (
                      <button className="danger" onClick={onDeleteDoc}>
                        Confirm delete
                      </button>
                    ) : (
                      <button className="danger" onClick={() => setConfirmDelete(true)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {status !== 'connected' && <span className={`status ${status}`}>{status}…</span>}
          <UserMenu />
        </div>
        <div className={`panes ${mode} ${previewCollapsed ? 'preview-hidden' : ''}`}>
          <div className="pane pane-editor" ref={editorRef} />
          {mode === 'split' && (
            <div
              className="divider"
              onClick={togglePreview}
              title={previewCollapsed ? 'Show preview (⌘P)' : 'Hide preview (⌘P)'}
            >
              <span className="divider-btn">{previewCollapsed ? '‹' : '›'}</span>
            </div>
          )}
          <div
            className={`pane pane-preview ${mode === 'preview' && hasComments ? 'with-comments' : ''}`}
            ref={previewRef}
            onDoubleClick={onPreviewDoubleClick}
          >
            <div className="preview-inner" ref={previewInnerRef}>
              <Preview text={text} />
            </div>
            {mode === 'preview' && ydoc && (
              <CommentMargin
                doc={ydoc}
                text={text}
                paneRef={previewRef}
                contentRef={previewInnerRef}
                displayName={displayName}
                avatarUrl={user?.imageUrl}
                showResolved={showResolved}
                onHasComments={setHasComments}
              />
            )}
          </div>
        </div>

        {ai?.kind === 'menu' && (
          <div
            className="ai-menu"
            style={{ top: Math.min(ai.y + 6, window.innerHeight - 170), left: Math.min(ai.x, window.innerWidth - 220) }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ai-menu-label">Ask AI</div>
            <button autoFocus onClick={() => setAi({ kind: 'ask', x: ai.x, y: ai.y, at: ai.at })}>
              Ask a question
            </button>
            <button onClick={() => setAi({ kind: 'write', x: ai.x, y: ai.y, at: ai.at })}>Write with AI</button>
            <button onClick={() => setAi({ kind: 'doc', x: ai.x, y: ai.y })}>Rewrite document</button>
          </div>
        )}
        {ai && ai.kind !== 'menu' && viewRef.current && (
          <AiAssist view={viewRef.current} trigger={ai} docText={text} onClose={() => setAi(null)} />
        )}
        {selBtn && !ai && (
          <button
            className="ai-sel-btn"
            style={{ top: Math.min(selBtn.y + 6, window.innerHeight - 40), left: selBtn.x }}
            onClick={(e) => {
              e.stopPropagation()
              setAi({ kind: 'selection', x: selBtn.x, y: selBtn.y, from: selBtn.from, to: selBtn.to, text: selBtn.text })
              setSelBtn(null)
            }}
          >
            ✨ Ask AI
          </button>
        )}
      </div>

      {historyOpen && (
        <div className="modal-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="history-panel" onClick={(e) => e.stopPropagation()}>
            <header className="history-head">
              <span>Version history</span>
              <button className="icon-btn" onClick={() => setHistoryOpen(false)} aria-label="Close">
                ✕
              </button>
            </header>
            <div className="history-list">
              {versions === null && <p className="muted">Loading…</p>}
              {versions?.length === 0 && <p className="muted">No versions yet.</p>}
              {versions?.map((v) => (
                <button key={v.id} className="history-row" onClick={() => onViewVersion(v.n)}>
                  <span className="history-v">v{v.n}</span>
                  <span className="history-msg">{v.message || v.source}</span>
                  <span className="muted history-meta">
                    {v.authorEmail ?? v.source} · {new Date(v.createdAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {viewingVersion && (
        <div className="modal-overlay" onClick={() => setViewingVersion(null)}>
          <div className="history-viewer" onClick={(e) => e.stopPropagation()}>
            <header className="history-head">
              <span>Version {viewingVersion.n}</span>
              <button className="icon-btn" onClick={() => setViewingVersion(null)} aria-label="Close">
                ✕
              </button>
            </header>
            <div className="preview-inner history-viewer-body">
              <Preview text={viewingVersion.content} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
