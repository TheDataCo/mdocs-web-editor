import { useClerk } from '@clerk/clerk-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getSharedDoc } from '../api'
import { Wordmark } from '../components/Wordmark'
import { Preview } from './Preview'

// Read-only view of a doc opened via a share link by a logged-out visitor.
// They can read and Copy; Edit sends them to sign in (editing needs an account).
// Once signed in, /d/:id renders the live EditorPage, which redeems the link.
export function SharedView() {
  const { id } = useParams<{ id: string }>()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copied, setCopied] = useState(false)
  const { redirectToSignIn } = useClerk()

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('share') ?? ''
    getSharedDoc(id!, token).then(
      (d) => {
        setTitle(d.title)
        setText(d.content)
        setState('ready')
      },
      () => setState('error'),
    )
  }, [id])

  // Come back to this exact doc (share token intact) after authenticating.
  const goSignIn = () => redirectToSignIn({ signInForceRedirectUrl: window.location.href })

  function onCopy() {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  if (state === 'error') {
    return (
      <div className="shared-empty">
        <Wordmark />
        <h1>This link isn’t available</h1>
        <p className="muted">The share link is invalid, expired, or has been revoked.</p>
        <button className="btn primary" onClick={goSignIn}>
          Sign in
        </button>
      </div>
    )
  }

  return (
    <div className="editor-shell">
      <div className="editor-main">
        <div className="topbar">
          <Wordmark />
          <span className="shared-title">{title}</span>
          <span className="badge">View only</span>
          <span className="spacer" />
          <button className="btn" onClick={onCopy} title="Copy markdown" disabled={state !== 'ready'}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button className="btn primary" onClick={goSignIn} title="Sign in to edit">
            Edit
          </button>
        </div>
        <div className="panes preview">
          <div className="pane pane-preview">
            <div className="preview-inner">
              {state === 'loading' ? <p className="muted">Loading…</p> : <Preview text={text} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
