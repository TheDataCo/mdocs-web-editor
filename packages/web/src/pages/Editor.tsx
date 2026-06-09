import { UserButton } from '@clerk/clerk-react'
import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { DocMeta } from '@datadocs/core'
import { DOC_TEXT_FIELD } from '@datadocs/core'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { getDoc, renameDoc, shareDoc } from '../api'
import { getToken } from '../auth'
import { DocTree } from '../components/DocTree'
import { WS_URL } from '../config'
import { Preview } from './Preview'

// 'split' = source + live preview side by side (editing); 'preview' = single
// rendered reading pane.
type Mode = 'split' | 'preview'

const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ee6352', '#9ac2c9', '#8acb88', '#e36397']
const NAMES = ['Ada', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Alan']

export function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [status, setStatus] = useState('connecting')
  const [text, setText] = useState('')
  // Split (source + live preview) is the default; last choice remembered per doc.
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(`datadocs:view:${id}`) === 'preview' ? 'preview' : 'split',
  )

  const editorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const modeRef = useRef(mode)
  const titleSaveRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toggleRef = useRef(() => {})
  toggleRef.current = () => setMode(modeRef.current === 'preview' ? 'split' : 'preview')

  useEffect(() => {
    getDoc(id!).then(setMeta, () =>
      setMeta({ id: id!, title: 'Unknown doc', workspaceId: null, createdAt: '', updatedAt: '' }),
    )
  }, [id])

  // Inline title editing: update local state immediately (optimistic), debounce
  // the persist so we're not firing a request per keystroke.
  function onTitleChange(title: string) {
    setMeta((m) => (m ? { ...m, title } : m))
    clearTimeout(titleSaveRef.current)
    titleSaveRef.current = setTimeout(() => {
      if (title.trim()) renameDoc(id!, title.trim()).catch(() => {})
    }, 500)
  }

  async function onShare() {
    const email = window.prompt('Share with (email) — or leave blank to copy the link')
    if (email && email.trim()) {
      const { status } = await shareDoc(id!, email.trim())
      window.alert(
        status === 'shared'
          ? `Shared with ${email}`
          : `No mdocs account for ${email} yet — they can sign in, then you can share.`,
      )
      return
    }
    await navigator.clipboard?.writeText(window.location.href).catch(() => {})
    window.alert('Link copied. (People you share with need access to open it.)')
  }

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: id!,
      token: getToken, // Clerk session token, refreshed per (re)connect
      document: doc,
      onStatus({ status }) {
        setStatus(status)
      },
    })

    const ytext = doc.getText(DOC_TEXT_FIELD)
    const undoManager = new Y.UndoManager(ytext)
    provider.awareness?.setLocalStateField('user', {
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    })

    const view = new EditorView({
      extensions: [
        // Cmd/Ctrl+E toggles views from inside the editor.
        keymap.of([{ key: 'Mod-e', run: () => (toggleRef.current(), true) }]),
        keymap.of(yUndoManagerKeymap),
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness, { undoManager }),
      ],
      parent: editorRef.current!,
    })
    viewRef.current = view

    const syncPreviewText = () => setText(ytext.toString())
    ytext.observe(syncPreviewText)
    provider.on('synced', syncPreviewText)

    return () => {
      ytext.unobserve(syncPreviewText)
      view.destroy()
      viewRef.current = null
      provider.destroy()
      doc.destroy()
    }
  }, [id])

  // Mode side effects: persist choice; entering split focuses the editor.
  useEffect(() => {
    modeRef.current = mode
    localStorage.setItem(`datadocs:view:${id}`, mode)
    if (mode === 'split') viewRef.current?.focus()
  }, [mode, id])

  // Global keys: Cmd/Ctrl+E toggles; in preview, any printable key jumps to
  // split so you can start editing immediately.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return // CodeMirror already handled it
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        toggleRef.current()
        return
      }
      if (modeRef.current !== 'preview' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length === 1) {
        e.preventDefault()
        setMode('split')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Double-click a preview block → put the cursor at that source line (and, in
  // single-pane preview, switch to split so the editor is visible).
  function onPreviewDoubleClick(e: React.MouseEvent) {
    const view = viewRef.current
    const el = (e.target as HTMLElement).closest('[data-line]')
    if (view && el) {
      const line = Math.min(Number(el.getAttribute('data-line')) || 1, view.state.doc.lines)
      view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, scrollIntoView: true })
    }
    if (modeRef.current === 'preview') setMode('split')
  }

  return (
    <div className="editor-shell">
      <DocTree activeDocId={id} />
      <div className="editor-main">
        <div className="topbar">
          <input
            className="title-input"
            value={meta?.title ?? ''}
            placeholder="Untitled"
            onChange={(e) => onTitleChange(e.target.value)}
            aria-label="Document title"
          />
          <span className="spacer" />
          <button className="btn" onClick={onShare}>
            Share
          </button>
          <button className="btn" onClick={() => toggleRef.current()} title="Toggle view (Cmd+E)">
            {mode === 'preview' ? 'Edit' : 'Read'} <kbd>⌘E</kbd>
          </button>
          <span className={`status ${status}`}>{status}</span>
          <UserButton />
        </div>
        <div className={`panes ${mode}`}>
          <div className="pane pane-editor" ref={editorRef} />
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
