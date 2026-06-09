import { UserButton } from '@clerk/clerk-react'
import type { DocMeta } from '@datadocs/core'
import { useEffect, useRef, useState } from 'react'
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
  renameWorkspace,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

function nextUntitled(docs: DocMeta[]): string {
  const nums = docs
    .map((d) => (d.title === 'Untitled' ? 1 : Number(d.title.match(/^Untitled (\d+)$/)?.[1] ?? 0)))
    .filter((n) => n > 0)
  return nums.length ? `Untitled ${Math.max(...nums) + 1}` : 'Untitled'
}

export function DocListPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingDoc, setRenamingDoc] = useState<string | null>(null)
  const [renamingWs, setRenamingWs] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
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
    const close = () => {
      setMenuFor(null)
      setConfirmDelete(null)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  async function onCreate() {
    if (!activeId) return
    const doc = await createDoc(nextUntitled(docs ?? []), activeId)
    navigate(`/d/${doc.id}`)
  }

  async function onNewWorkspace() {
    const ws = await createWorkspace('Untitled')
    setWorkspaces((cur) => [...cur, ws])
    setActiveId(ws.id)
    setRenamingWs(ws.id) // drop straight into inline name editing
  }

  function commitWsRename(ws: Workspace, name: string) {
    setRenamingWs(null)
    const next = name.trim()
    if (!next || next === ws.name) return
    setWorkspaces((cur) => cur.map((w) => (w.id === ws.id ? { ...w, name: next } : w)))
    renameWorkspace(ws.id, next).catch(() => listWorkspaces().then(setWorkspaces))
  }

  function commitDocRename(doc: DocMeta, title: string) {
    setRenamingDoc(null)
    const next = title.trim()
    if (!next || next === doc.title) return
    setDocs((cur) => cur?.map((d) => (d.id === doc.id ? { ...d, title: next } : d)) ?? null)
    renameDoc(doc.id, next).catch(() => listDocs(activeId!).then(setDocs))
  }

  function onDelete(doc: DocMeta) {
    setMenuFor(null)
    setConfirmDelete(null)
    setDocs((cur) => cur?.filter((d) => d.id !== doc.id) ?? null)
    deleteDoc(doc.id).catch(() => listDocs(activeId!).then(setDocs))
  }

  async function onCreateToken() {
    const { token } = await createToken('CLI token')
    await navigator.clipboard?.writeText(token).catch(() => {})
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 1800)
  }

  return (
    <>
      <div className="topbar">
        <Wordmark />
        <span className="spacer" />
        <button className="btn" onClick={onCreateToken} title="Generate a token for the CLI (copied to clipboard)">
          {tokenCopied ? 'Token copied ✓' : 'CLI token'}
        </button>
        <UserButton />
      </div>
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-label">Workspaces</div>
          {workspaces.map((w) =>
            renamingWs === w.id ? (
              <input
                key={w.id}
                className="ws-rename"
                autoFocus
                defaultValue={w.name}
                onBlur={(e) => commitWsRename(w, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setRenamingWs(null)
                }}
              />
            ) : (
              <button
                key={w.id}
                className={`ws-item ${w.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(w.id)}
                onDoubleClick={() => setRenamingWs(w.id)}
                title="Double-click to rename"
              >
                <span className="ws-glyph">{w.type === 'personal' ? '•' : '⬡'}</span>
                {w.name}
              </button>
            ),
          )}
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
                <button className="btn" onClick={() => { setInviteOpen((o) => !o); setInviteMsg(null) }}>
                  Invite
                </button>
              )}
              <button className="btn primary" onClick={onCreate} disabled={!activeId}>
                New doc
              </button>
            </div>
          </div>

          {inviteOpen && active?.type === 'team' && (
            <form
              className="invite-row"
              onSubmit={async (e) => {
                e.preventDefault()
                const input = e.currentTarget.elements.namedItem('email') as HTMLInputElement
                const email = input.value.trim()
                if (!email) return
                const { status } = await inviteMember(active.id, email)
                setInviteMsg(status === 'added' ? `Added ${email}` : `Invited ${email}`)
                input.value = ''
              }}
            >
              <input name="email" type="email" placeholder="Invite by email…" autoFocus />
              <button className="btn" type="submit">Add</button>
              {inviteMsg && <span className="muted">{inviteMsg}</span>}
            </form>
          )}

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
            {filtered.map((d) =>
              renamingDoc === d.id ? (
                <div key={d.id} className="row">
                  <input
                    className="row-rename"
                    autoFocus
                    defaultValue={d.title}
                    onBlur={(e) => commitDocRename(d, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenamingDoc(null)
                    }}
                  />
                </div>
              ) : (
                <div key={d.id} className="row" onClick={() => navigate(`/d/${d.id}`)}>
                  <span className="doclist-title">{d.title}</span>
                  <span className="muted row-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                  <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="kebab"
                      onClick={() => {
                        setMenuFor(menuFor === d.id ? null : d.id)
                        setConfirmDelete(null)
                      }}
                      aria-label="Document options"
                    >
                      ⋯
                    </button>
                    {menuFor === d.id && (
                      <div className="menu">
                        <button
                          onClick={() => {
                            setMenuFor(null)
                            setRenamingDoc(d.id)
                          }}
                        >
                          Rename
                        </button>
                        {confirmDelete === d.id ? (
                          <button className="danger" onClick={() => onDelete(d)}>
                            Confirm delete
                          </button>
                        ) : (
                          <button className="danger" onClick={() => setConfirmDelete(d.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </main>
      </div>
    </>
  )
}
