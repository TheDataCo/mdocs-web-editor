import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { DocMeta } from '@datadocs/core'
import { DOC_TEXT_FIELD } from '@datadocs/core'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { getDoc } from '../api'
import { TOKEN, WS_URL } from '../config'
import { Preview } from './Preview'

type Mode = 'raw' | 'preview'

const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ee6352', '#9ac2c9', '#8acb88', '#e36397']
const NAMES = ['Ada', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Alan']

export function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [status, setStatus] = useState('connecting')
  const [text, setText] = useState('')
  // Raw is the default editing surface; last choice remembered per doc.
  const [mode, setMode] = useState<Mode>(() =>
    localStorage.getItem(`datadocs:view:${id}`) === 'preview' ? 'preview' : 'raw',
  )

  const editorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const modeRef = useRef(mode)
  const toggleRef = useRef(() => {})
  toggleRef.current = () => setMode(modeRef.current === 'raw' ? 'preview' : 'raw')

  useEffect(() => {
    getDoc(id!).then(setMeta, () => setMeta({ id: id!, title: 'Unknown doc', createdAt: '', updatedAt: '' }))
  }, [id])

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: id!,
      token: TOKEN,
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

  // Mode side effects: persist choice; entering raw focuses the editor,
  // entering preview scrolls to the block containing the cursor.
  useEffect(() => {
    modeRef.current = mode
    localStorage.setItem(`datadocs:view:${id}`, mode)
    const view = viewRef.current
    if (!view) return
    if (mode === 'raw') {
      view.focus()
      view.dispatch({ scrollIntoView: true })
    } else if (previewRef.current) {
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number
      let target: Element | null = null
      for (const el of previewRef.current.querySelectorAll('[data-line]')) {
        if (Number(el.getAttribute('data-line')) <= cursorLine) target = el
        else break
      }
      target?.scrollIntoView({ block: 'center' })
    }
  }, [mode, id])

  // Global keys: Cmd/Ctrl+E anywhere; in preview, Shift+V or any printable
  // keypress drops into raw ("when editing, always raw" — made automatic).
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
        setMode('raw')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Double-click a preview block → raw, cursor at that block's source line.
  function onPreviewDoubleClick(e: React.MouseEvent) {
    const view = viewRef.current
    const el = (e.target as HTMLElement).closest('[data-line]')
    if (view && el) {
      const line = Math.min(Number(el.getAttribute('data-line')) || 1, view.state.doc.lines)
      view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, scrollIntoView: true })
    }
    setMode('raw')
  }

  return (
    <>
      <div className="topbar">
        <Link to="/" className="back">
          ←
        </Link>
        <h1>{meta?.title ?? '…'}</h1>
        <button className="btn" onClick={() => toggleRef.current()} title="Toggle view (Cmd+E)">
          {mode === 'raw' ? 'Preview' : 'Edit'} <kbd>⌘E</kbd>
        </button>
        <span className={`status ${status}`}>{status}</span>
      </div>
      <div className="editor-wrap" ref={editorRef} style={{ display: mode === 'raw' ? undefined : 'none' }} />
      <div
        className="preview-wrap"
        ref={previewRef}
        onDoubleClick={onPreviewDoubleClick}
        style={{ display: mode === 'preview' ? undefined : 'none' }}
      >
        <Preview text={text} />
      </div>
    </>
  )
}
