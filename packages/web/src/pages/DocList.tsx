import { UserButton } from '@clerk/clerk-react'
import type { DocMeta } from '@datadocs/core'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createDoc, createToken, listDocs } from '../api'

export function DocListPage() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    listDocs().then(setDocs, (e) => setError(String(e)))
  }, [])

  async function onCreate() {
    const title = window.prompt('Document title', 'Untitled')
    if (title === null) return
    const doc = await createDoc(title)
    navigate(`/d/${doc.id}`)
  }

  async function onCreateToken() {
    const name = window.prompt('Name this CLI token', 'My laptop')
    if (name === null) return
    const { token } = await createToken(name)
    // Shown once — the server only stores the hash.
    window.prompt('Copy your token now (shown once):', token)
  }

  return (
    <>
      <div className="topbar">
        <h1>datadocs</h1>
        <button className="btn" onClick={onCreateToken} title="Generate a token for the CLI">
          CLI token
        </button>
        <button className="btn" onClick={onCreate}>
          New doc
        </button>
        <UserButton />
      </div>
      <div className="doclist">
        {error && <p className="error">{error}</p>}
        {docs === null && !error && <p className="muted">Loading…</p>}
        {docs?.length === 0 && <p className="muted">No documents yet — create one.</p>}
        {docs?.map((d) => (
          <Link key={d.id} className="doclist-item" to={`/d/${d.id}`}>
            <span className="doclist-title">{d.title}</span>
            <span className="muted">{new Date(d.updatedAt).toLocaleString()}</span>
          </Link>
        ))}
      </div>
    </>
  )
}
