import { useAuth } from '@clerk/clerk-react'
import { UserMenu } from '../components/UserMenu'
import type { DocMeta } from '@mdocs/core'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BILLING_ON } from '../config'
import {
  createDoc,
  createWorkspace,
  deleteDoc,
  deleteWorkspace,
  inviteMember,
  listDocs,
  listShared,
  listTrash,
  listWorkspaces,
  moveDoc,
  renameDoc,
  renameWorkspace,
  restoreDoc,
  restoreWorkspace,
  type Trash,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

// Sentinel "workspace" ids for the virtual Shared and Recently deleted views.
const SHARED = '__shared__'
const TRASH = '__trash__'

function daysLeft(deletedAt: string, retentionDays: number): string {
  const expires = new Date(deletedAt).getTime() + retentionDays * 86400_000
  const days = Math.ceil((expires - Date.now()) / 86400_000)
  return days <= 0 ? 'expires today' : days === 1 ? '1 day left' : `${days} days left`
}
type Row = DocMeta & { ownerEmail?: string | null; ownerName?: string | null }

function nextUntitled(docs: DocMeta[]): string {
  const nums = docs
    .map((d) => (d.title === 'Untitled' ? 1 : Number(d.title.match(/^Untitled (\d+)$/)?.[1] ?? 0)))
    .filter((n) => n > 0)
  return nums.length ? `Untitled ${Math.max(...nums) + 1}` : 'Untitled'
}

export function DocListPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [docs, setDocs] = useState<Row[] | null>(null)
  const [trash, setTrash] = useState<Trash | null>(null)
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingDoc, setRenamingDoc] = useState<string | null>(null)
  const [renamingWs, setRenamingWs] = useState<string | null>(null)
  const [menuWs, setMenuWs] = useState<string | null>(null)
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropWs, setDropWs] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { has } = useAuth()
  // Team workspaces require the Pro plan on the hosted instance (Clerk slug is
  // still 'individual' from before the rename); self-host allows everything.
  const canTeam = !BILLING_ON || (has?.({ plan: 'individual' }) ?? false)

  function onDropToWorkspace(workspaceId: string) {
    const id = dragId
    setDragId(null)
    setDropWs(null)
    if (!id) return
    setDocs((cur) => cur?.filter((d) => d.id !== id) ?? null) // leaves the current list
    moveDoc(id, workspaceId).catch(() => {
      if (activeId) listDocs(activeId).then(setDocs)
    })
  }

  const isShared = activeId === SHARED
  const isTrash = activeId === TRASH
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
    if (activeId === TRASH) {
      setTrash(null)
      listTrash().then(setTrash, (e) => setError(String(e)))
      return
    }
    setDocs(null)
    const load = activeId === SHARED ? listShared() : listDocs(activeId)
    load.then(setDocs, (e) => setError(String(e)))
  }, [activeId])

  useEffect(() => {
    const close = () => {
      setMenuFor(null)
      setConfirmDelete(null)
      setMenuWs(null)
      setConfirmDeleteWs(null)
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
    if (!canTeam) return void navigate('/account?upgrade=workspaces') // shows the limit + Upgrade
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

  function onDeleteWorkspace(ws: Workspace) {
    setMenuWs(null)
    setConfirmDeleteWs(null)
    setWorkspaces((cur) => cur.filter((w) => w.id !== ws.id))
    if (activeId === ws.id) setActiveId(workspaces.find((w) => w.id !== ws.id)?.id ?? null)
    deleteWorkspace(ws.id).catch(() => listWorkspaces().then(setWorkspaces))
  }

  function onRestoreDoc(id: string) {
    setTrash((t) => (t ? { ...t, docs: t.docs.filter((d) => d.id !== id) } : t))
    restoreDoc(id).catch(() => listTrash().then(setTrash))
  }

  function onRestoreWorkspace(id: string) {
    setTrash((t) => (t ? { ...t, workspaces: t.workspaces.filter((w) => w.id !== id) } : t))
    restoreWorkspace(id)
      .then(() => listWorkspaces().then(setWorkspaces))
      .catch(() => listTrash().then(setTrash))
  }

  return (
    <>
      <div className="topbar">
        <Wordmark />
        <span className="spacer" />
        <UserMenu />
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
              <div
                key={w.id}
                className={`ws-item ${w.id === activeId ? 'active' : ''} ${dropWs === w.id ? 'drop' : ''}`}
                onClick={() => (w.id === activeId ? setRenamingWs(w.id) : setActiveId(w.id))}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault()
                    setDropWs(w.id)
                  }
                }}
                onDragLeave={() => setDropWs((d) => (d === w.id ? null : d))}
                onDrop={() => onDropToWorkspace(w.id)}
                title={w.id === activeId ? 'Click to rename' : w.name}
              >
                <span className="ws-glyph">•</span>
                <span className="ws-name">{w.name}</span>
                <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="kebab"
                    onClick={() => {
                      setMenuWs(menuWs === w.id ? null : w.id)
                      setConfirmDeleteWs(null)
                    }}
                    aria-label="Workspace options"
                  >
                    ⋯
                  </button>
                  {menuWs === w.id && (
                    <div className="menu">
                      <button
                        onClick={() => {
                          setMenuWs(null)
                          setRenamingWs(w.id)
                        }}
                      >
                        Rename
                      </button>
                      {w.type === 'team' && w.role === 'owner' && (
                        confirmDeleteWs === w.id ? (
                          <button className="danger" onClick={() => onDeleteWorkspace(w)}>
                            Confirm delete
                          </button>
                        ) : (
                          <button className="danger" onClick={() => setConfirmDeleteWs(w.id)}>
                            Delete
                          </button>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          <button
            className={`ws-item ${isShared ? 'active' : ''}`}
            onClick={() => setActiveId(SHARED)}
            title="Documents shared with you and ones you've shared"
          >
            <span className="ws-glyph">⬡</span>
            Shared
          </button>
          <button
            className={`ws-item ${isTrash ? 'active' : ''}`}
            onClick={() => setActiveId(TRASH)}
            title="Deleted documents and workspaces you can still restore"
          >
            <span className="ws-glyph">↺</span>
            Recently deleted
          </button>
          <button className="ws-item new" onClick={onNewWorkspace}>
            + New workspace
          </button>
          <a
            className="ws-item new"
            href="https://github.com/TheDataCo/mdocs"
            target="_blank"
            rel="noreferrer"
            title="Install the mdocs CLI — pull, edit, and push docs from your terminal or agent"
          >
            <span className="ws-glyph">⌨</span>
            Get the CLI
          </a>
        </aside>

        <main className="content">
          {error && <p className="error">{error}</p>}
          <div className="content-head">
            <h2>{isTrash ? 'Recently deleted' : isShared ? 'Shared' : (active?.name ?? 'Documents')}</h2>
            <div className="content-actions">
              {active?.type === 'team' && !isShared && (
                <button className="btn" onClick={() => { setInviteOpen((o) => !o); setInviteMsg(null) }}>
                  Invite
                </button>
              )}
              {!isShared && !isTrash && (
                <button className="btn primary" onClick={onCreate} disabled={!activeId}>
                  New doc
                </button>
              )}
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
                try {
                  const { status } = await inviteMember(active.id, email)
                  setInviteMsg(status === 'added' ? `Added ${email}` : `Invited ${email}`)
                  input.value = ''
                } catch (err) {
                  setInviteMsg((err as Error).message)
                }
              }}
            >
              <input name="email" type="email" placeholder="Invite by email…" autoFocus />
              <button className="btn" type="submit">Add</button>
              {inviteMsg && <span className="muted">{inviteMsg}</span>}
            </form>
          )}

          {isTrash && (
            <div className="doclist compact">
              {trash === null && !error && <p className="muted">Loading…</p>}
              {trash && (
                <>
                  <p className="muted trash-note">
                    Deleted items can be restored for {trash.retentionDays} days.
                    {BILLING_ON && trash.retentionDays < 90 && (
                      <>
                        {' '}
                        <a href="/account?upgrade=trash">Upgrade</a> to keep them for 90 days.
                      </>
                    )}
                  </p>
                  {trash.workspaces.length === 0 && trash.docs.length === 0 && (
                    <p className="muted">Nothing in the trash.</p>
                  )}
                  {trash.workspaces.map((w) => (
                    <div key={w.id} className="row trash-row">
                      <span className="ws-glyph">•</span>
                      <span className="doclist-title">{w.name}</span>
                      <span className="muted">
                        Workspace · {w.docCount} {w.docCount === 1 ? 'doc' : 'docs'}
                      </span>
                      <span className="muted row-date">{daysLeft(w.deletedAt, trash.retentionDays)}</span>
                      <button className="btn" onClick={() => onRestoreWorkspace(w.id)}>
                        Restore
                      </button>
                    </div>
                  ))}
                  {trash.docs.map((d) => (
                    <div key={d.id} className="row trash-row">
                      <span className="ws-glyph">¶</span>
                      <span className="doclist-title">{d.title || 'Untitled'}</span>
                      <span className="muted">{d.workspaceName}</span>
                      <span className="muted row-date">{daysLeft(d.deletedAt, trash.retentionDays)}</span>
                      <button className="btn" onClick={() => onRestoreDoc(d.id)}>
                        Restore
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {!isTrash && (
          <input
            className="search"
            type="search"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          )}

          {!isTrash && (
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
                <div
                  key={d.id}
                  className={`row ${dragId === d.id ? 'dragging' : ''}`}
                  draggable={!isShared}
                  onDragStart={() => setDragId(d.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => navigate(`/d/${d.id}`)}
                >
                  <span className="doclist-title">{d.title}</span>
                  {isShared && (
                    <span className="muted row-owner">{d.ownerName || d.ownerEmail || '—'}</span>
                  )}
                  <span className="muted row-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                  {!isShared && (
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
                  )}
                </div>
              ),
            )}
          </div>
          )}
        </main>
      </div>
    </>
  )
}
