import { UserButton } from '@clerk/clerk-react'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { DocMeta } from '@datadocs/core'
import { DOC_TEXT_FIELD } from '@datadocs/core'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { createLink, getDoc, redeemLink, renameDoc, shareDoc } from '../api'
import { getToken } from '../auth'
import { DocTree } from '../components/DocTree'
import { WS_URL } from '../config'
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
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(`datadocs:view:${id}`) === 'preview' ? 'preview' : 'split',
  )
  const [treeCollapsed, setTreeCollapsed] = useState(() => localStorage.getItem('mdocs:sidebar') === '1')
  const [previewCollapsed, setPreviewCollapsed] = useState(() => localStorage.getItem('mdocs:preview') === '1')

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
  const viewRef = useRef<EditorView | null>(null)
  const modeRef = useRef(mode)
  const titleSaveRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toggleRef = useRef(() => {})
  toggleRef.current = () => setMode(modeRef.current === 'preview' ? 'split' : 'preview')
  const previewToggleRef = useRef(() => {})
  previewToggleRef.current = togglePreview

  // Load access: redeem a share link if present in the URL, then fetch the doc
  // + the caller's edit permission. Gate the editor build on this completing.
  useEffect(() => {
    let cancelled = false
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
        if (!d.canEdit && localStorage.getItem(`datadocs:view:${id}`) !== 'split') setMode('preview')
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
          { key: 'Mod-e', run: () => (toggleRef.current(), true) },
          { key: 'Mod-p', preventDefault: true, run: () => (previewToggleRef.current(), true) },
        ]),
        keymap.of(yUndoManagerKeymap),
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!canEdit), // viewers can't type (server enforces too)
        yCollab(ytext, awareness, { undoManager }),
      ],
      parent: editorRef.current!,
    })
    viewRef.current = view

    const syncPreviewText = () => setText(ytext.toString())
    ytext.observe(syncPreviewText)
    provider.on('synced', syncPreviewText)

    return () => {
      awareness.off('change', updatePeers)
      ytext.unobserve(syncPreviewText)
      view.destroy()
      viewRef.current = null
      provider.destroy()
      doc.destroy()
    }
  }, [id, canEdit])

  useEffect(() => {
    modeRef.current = mode
    localStorage.setItem(`datadocs:view:${id}`, mode)
    if (mode === 'split') viewRef.current?.focus()
  }, [mode, id])

  // CodeMirror must re-measure when the panes resize (preview show/hide).
  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [previewCollapsed, treeCollapsed])

  // Close the share menu on any outside click.
  useEffect(() => {
    const close = () => setShareOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return
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

  function onPreviewDoubleClick(e: React.MouseEvent) {
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
      {!treeCollapsed && <DocTree activeDocId={id} />}
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
            readOnly={!canEdit}
            aria-label="Document title"
          />
          {canEdit === false && <span className="badge">View only</span>}
          <span className="spacer" />
          <div className="peers">
            {peers.map((p, i) => (
              <span key={i} className="avatar" style={{ background: p.color }} title={p.name}>
                {p.name.charAt(0)}
              </span>
            ))}
          </div>
          {canEdit && (
            <div className="share-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="btn" onClick={() => setShareOpen((o) => !o)}>
                Share
              </button>
              {shareOpen && (
                <div className="menu share-menu">
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
                  <button onClick={() => onCopyLink('editor')}>
                    {copied === 'editor' ? 'Copied ✓' : 'Copy edit link'}
                  </button>
                  <button onClick={() => onCopyLink('viewer')}>
                    {copied === 'viewer' ? 'Copied ✓' : 'Copy read-only link'}
                  </button>
                </div>
              )}
            </div>
          )}
          <button className="btn" onClick={() => toggleRef.current()} title="Toggle view (Cmd+E)">
            {mode === 'preview' ? 'Edit' : 'Read'} <kbd>⌘E</kbd>
          </button>
          <span className={`status ${status}`}>{status}</span>
          <UserButton />
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
          <div className="pane pane-preview" ref={previewRef} onDoubleClick={onPreviewDoubleClick}>
            <div className="preview-inner">
              <Preview text={text} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
