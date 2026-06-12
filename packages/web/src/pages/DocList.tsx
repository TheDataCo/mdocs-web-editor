import { UserButton } from '@clerk/clerk-react'
import type { DocMeta } from '@mdocs/core'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createDoc,
  createWorkspace,
  deleteDoc,
  getPlan,
  inviteMember,
  listDocs,
  listShared,
  listWorkspaces,
  moveDoc,
  type PlanInfo,
  renameDoc,
  renameWorkspace,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

// Sentinel "workspace" id for the virtual Shared view.
const SHARED = '__shared__'
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
  const [query, setQuery] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingDoc, setRenamingDoc] = useState<string | null>(null)
  const [renamingWs, setRenamingWs] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropWs, setDropWs] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

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
    getPlan().then(setPlan, () => {})
  }, [])

  useEffect(() => {
    if (!activeId) return
    setDocs(null)
    const load = activeId === SHARED ? listShared() : listDocs(activeId)
    load.then(setDocs, (e) => setError(String(e)))
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

  return (
    <>
      <div className="topbar">
        <Wordmark />
        <span className="spacer" />
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
                className={`ws-item ${w.id === activeId ? 'active' : ''} ${dropWs === w.id ? 'drop' : ''}`}
                onClick={() => setActiveId(w.id)}
                onDoubleClick={() => setRenamingWs(w.id)}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault()
                    setDropWs(w.id)
                  }
                }}
                onDragLeave={() => setDropWs((d) => (d === w.id ? null : d))}
                onDrop={() => onDropToWorkspace(w.id)}
                title="Double-click to rename"
              >
                <span className="ws-glyph">•</span>
                {w.name}
              </button>
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
          <button className="ws-item new" onClick={onNewWorkspace}>
            + New workspace
          </button>
          {plan && (
            <div className="plan-footer" title="Your plan and usage">
              <span className="plan-name">{plan.planName}</span>
              <span className="plan-usage">
                {plan.usage.docs}
                {plan.entitlements.maxDocs != null ? `/${plan.entitlements.maxDocs}` : ''} docs
                {plan.entitlements.maxCollaborators != null &&
                  ` · ${plan.usage.collaborators}/${plan.entitlements.maxCollaborators} shared`}
              </span>
            </div>
          )}
        </aside>

        <main className="content">
          {error && <p className="error">{error}</p>}
          <div className="content-head">
            <h2>{isShared ? 'Shared' : (active?.name ?? 'Documents')}</h2>
            <div className="content-actions">
              {active?.type === 'team' && !isShared && (
                <button className="btn" onClick={() => { setInviteOpen((o) => !o); setInviteMsg(null) }}>
                  Invite
                </button>
              )}
              {!isShared && (
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
        </main>
      </div>
    </>
  )
}
