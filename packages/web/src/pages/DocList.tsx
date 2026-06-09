import { UserButton } from '@clerk/clerk-react'
import type { DocMeta } from '@datadocs/core'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  createDoc,
  createToken,
  createWorkspace,
  inviteMember,
  listDocs,
  listWorkspaces,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

export function DocListPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const active = workspaces.find((w) => w.id === activeId) ?? null

  useEffect(() => {
    listWorkspaces().then(
      (ws) => {
        setWorkspaces(ws)
        setActiveId((cur) => cur ?? ws[0]?.id ?? null)
      },
      (e) => setError(String(e)),
    )
  }, [])

  useEffect(() => {
    if (!activeId) return
    setDocs(null)
    listDocs(activeId).then(setDocs, (e) => setError(String(e)))
  }, [activeId])

  async function onCreate() {
    const title = window.prompt('Document title', 'Untitled')
    if (title === null || !activeId) return
    const doc = await createDoc(title, activeId)
    navigate(`/d/${doc.id}`)
  }

  async function onNewWorkspace() {
    const name = window.prompt('Team workspace name', 'My Team')
    if (name === null) return
    const ws = await createWorkspace(name)
    setWorkspaces((cur) => [...cur, ws])
    setActiveId(ws.id)
  }

  async function onInvite() {
    if (!active || active.type !== 'team') return
    const email = window.prompt(`Invite someone to ${active.name} (email)`)
    if (!email) return
    const { status } = await inviteMember(active.id, email)
    window.alert(status === 'added' ? `${email} added to ${active.name}` : `Invitation queued for ${email}`)
  }

  async function onCreateToken() {
    const name = window.prompt('Name this CLI token', 'My laptop')
    if (name === null) return
    const { token } = await createToken(name)
    window.prompt('Copy your token now (shown once):', token)
  }

  return (
    <>
      <div className="topbar">
        <Wordmark />
        <span className="spacer" />
        <button className="btn" onClick={onCreateToken} title="Generate a token for the CLI">
          CLI token
        </button>
        <UserButton />
      </div>
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-label">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={`ws-item ${w.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(w.id)}
            >
              <span className="ws-glyph">{w.type === 'personal' ? '•' : '⬡'}</span>
              {w.name}
            </button>
          ))}
          <button className="ws-item new" onClick={onNewWorkspace}>
            + New workspace
          </button>
        </aside>

        <main className="content">
          {error && <p className="error">{error}</p>}
          <div className="content-head">
            <h2>{active?.name ?? 'Documents'}</h2>
            <div className="content-actions">
              {active?.type === 'team' && (
                <button className="btn" onClick={onInvite}>
                  Invite
                </button>
              )}
              <button className="btn primary" onClick={onCreate} disabled={!activeId}>
                New doc
              </button>
            </div>
          </div>
          <div className="doclist">
            {docs === null && !error && <p className="muted">Loading…</p>}
            {docs?.length === 0 && <p className="muted">No documents yet — create one.</p>}
            {docs?.map((d) => (
              <Link key={d.id} className="doclist-item" to={`/d/${d.id}`}>
                <span className="doclist-title">{d.title}</span>
                <span className="muted">{new Date(d.updatedAt).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        </main>
      </div>
    </>
  )
}
