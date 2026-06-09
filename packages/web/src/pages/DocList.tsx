import { UserButton } from '@clerk/clerk-react'
import type { DocMeta } from '@datadocs/core'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createDoc,
  createToken,
  createWorkspace,
  deleteDoc,
  inviteMember,
  listDocs,
  listWorkspaces,
  renameDoc,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

// "Untitled", then "Untitled 2", "Untitled 3", … based on existing titles.
function nextUntitled(docs: DocMeta[]): string {
  const nums = docs
    .map((d) => {
      if (d.title === 'Untitled') return 1
      const m = d.title.match(/^Untitled (\d+)$/)
      return m ? Number(m[1]) : 0
    })
    .filter((n) => n > 0)
  if (nums.length === 0) return 'Untitled'
  return `Untitled ${Math.max(...nums) + 1}`
}

export function DocListPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const active = workspaces.find((w) => w.id === activeId) ?? null
  const filtered = (docs ?? []).filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))

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

  useEffect(() => {
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  async function onCreate() {
    if (!activeId) return
    const doc = await createDoc(nextUntitled(docs ?? []), activeId)
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

  async function onRename(doc: DocMeta) {
    const title = window.prompt('Rename document', doc.title)
    if (!title || title === doc.title) return
    setDocs((cur) => cur?.map((d) => (d.id === doc.id ? { ...d, title } : d)) ?? null) // optimistic
    renameDoc(doc.id, title).catch(() => listDocs(activeId!).then(setDocs)) // revert from server on failure
  }

  async function onDelete(doc: DocMeta) {
    if (!window.confirm(`Delete "${doc.title}"?`)) return
    setDocs((cur) => cur?.filter((d) => d.id !== doc.id) ?? null) // optimistic
    deleteDoc(doc.id).catch(() => listDocs(activeId!).then(setDocs))
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

          <input
            className="search"
            type="search"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="doclist compact">
            {docs === null && !error && <p className="muted">Loading…</p>}
            {docs && filtered.length === 0 && (
              <p className="muted">{query ? 'No matches.' : 'No documents yet — create one.'}</p>
            )}
            {filtered.map((d) => (
              <div key={d.id} className="row" onClick={() => navigate(`/d/${d.id}`)}>
                <span className="doclist-title">{d.title}</span>
                <span className="muted row-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="kebab"
                    onClick={() => setMenuFor(menuFor === d.id ? null : d.id)}
                    aria-label="Document options"
                  >
                    ⋯
                  </button>
                  {menuFor === d.id && (
                    <div className="menu">
                      <button onClick={() => onRename(d)}>Rename</button>
                      <button className="danger" onClick={() => onDelete(d)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </>
  )
}
