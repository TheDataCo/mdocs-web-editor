import { HocuspocusProvider } from '@hocuspocus/provider'
import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import { basicSetup, EditorView } from 'codemirror'
import { useEffect, useRef, useState } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { DOC_TEXT_FIELD } from '@datadocs/core'

// Milestone 1: a single hardcoded doc. Doc list + routing come in milestone 2.
const DOC_ID = '00000000-0000-0000-0000-000000000001'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001'
const TOKEN = import.meta.env.VITE_COLLAB_TOKEN ?? 'dev-token'

const COLORS = ['#30bced', '#6eeb83', '#ffbc42', '#ee6352', '#9ac2c9', '#8acb88', '#e36397']
const NAMES = ['Ada', 'Grace', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Alan']

export function App() {
  const editorRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: DOC_ID,
      token: TOKEN,
      document: doc,
      onStatus({ status }) {
        setStatus(status)
      },
    })

    const ytext = doc.getText(DOC_TEXT_FIELD)
    const undoManager = new Y.UndoManager(ytext)

    const me = {
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }
    provider.awareness?.setLocalStateField('user', me)

    const view = new EditorView({
      extensions: [
        keymap.of(yUndoManagerKeymap),
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness, { undoManager }),
      ],
      parent: editorRef.current!,
    })

    return () => {
      view.destroy()
      provider.destroy()
      doc.destroy()
    }
  }, [])

  return (
    <>
      <div className="topbar">
        <h1>datadocs</h1>
        <span className={`status ${status}`}>{status}</span>
      </div>
      <div className="editor-wrap" ref={editorRef} />
    </>
  )
}
