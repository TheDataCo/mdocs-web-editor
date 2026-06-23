import { useAuth } from '@clerk/clerk-react'
import { UserMenu } from '../components/UserMenu'
import type { DocMeta } from '@mdocs/core'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BILLING_ON } from '../config'
import {
  createDoc,
  createWorkspace,
  deleteDoc,
  deleteWorkspace,
  inviteMember,
  listDocs,
  listFavorites,
  listRecent,
  listShared,
  listTrash,
  listWorkspaces,
  moveDoc,
  renameDoc,
  renameWorkspace,
  restoreDoc,
  restoreWorkspace,
  setFavorite,
  setPin,
  type Trash,
  type Workspace,
} from '../api'
import { Wordmark } from '../components/Wordmark'

// Sentinel "workspace" ids for the virtual Recent, Favorites, Shared and
// Recently deleted views.
const RECENT = '__recent__'
const FAVORITES = '__favorites__'
const SHARED = '__shared__'
const TRASH = '__trash__'

function daysLeft(deletedAt: string, retentionDays: number): string {
  const expires = new Date(deletedAt).getTime() + retentionDays * 86400_000
  const days = Math.ceil((expires - Date.now()) / 86400_000)
  return days <= 0 ? 'expires today' : days === 1 ? '1 day left' : `${days} days left`
}
type Row = DocMeta & {
  favorite?: boolean
  pinned?: boolean
  ownerEmail?: string | null
  ownerName?: string | null
}

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
  // All docs across every workspace the user belongs to — the corpus for the
  // global search in the top header (loaded separately from the active view).
  const [allDocs, setAllDocs] = useState<Row[] | null>(null)
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
  const [cliCopied, setCliCopied] = useState(false)
  const navigate = useNavigate()
  const { has } = useAuth()
  // Team workspaces require the Pro plan on the hosted instance; self-host
  // allows everything.
  const canTeam = !BILLING_ON || (has?.({ plan: 'pro' }) ?? false)

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

  const isRecent = activeId === RECENT
  const isFavorites = activeId === FAVORITES
  const isShared = activeId === SHARED
  const isTrash = activeId === TRASH
  const isVirtual = isRecent || isFavorites || isShared || isTrash
  const showOwner = isShared || isFavorites || isRecent
  const active = workspaces.find((w) => w.id === activeId) ?? null
  const filtered = (docs ?? [])
    .filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))
    // In a real workspace, pinned docs float to the top (Recent keeps open-order).
    .sort((a, b) => (isVirtual ? 0 : Number(!!b.pinned) - Number(!!a.pinned)))

  // A non-empty query switches the content area to global, cross-workspace
  // search results instead of the active view.
  const q = query.trim()
  const searching = q.length > 0
  const wsName = (id: string | null) => workspaces.find((w) => w.id === id)?.name ?? 'Workspace'
  const results = (allDocs ?? [])
    .filter((d) => d.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title))

  useEffect(() => {
    listWorkspaces().then(
      (ws) => {
        setWorkspaces(ws)
        setActiveId((cur) => cur ?? ws[0]?.id ?? null)
      },
      (e) => setError(String(e)),
    )
  }, [])

  // Corpus for global search. Loaded once up front and refreshed whenever the
  // search field is focused, so results stay reasonably fresh without polling.
  function reloadAll() {
    listDocs().then((d) => setAllDocs(d as Row[]), (e) => setError(String(e)))
  }
  useEffect(() => {
    reloadAll()
  }, [])

  useEffect(() => {
    if (!activeId) return
    if (activeId === TRASH) {
      setTrash(null)
      listTrash().then(setTrash, (e) => setError(String(e)))
      return
    }
    setDocs(null)
    loadFor(activeId).then(setDocs, (e) => setError(String(e)))
  }, [activeId])

  function loadFor(id: string) {
    if (id === SHARED) return listShared()
    if (id === FAVORITES) return listFavorites()
    if (id === RECENT) return listRecent()
    return listDocs(id)
  }

  function reloadDocs() {
    loadFor(activeId!).then(setDocs, (e) => setError(String(e)))
  }

  // Star/unstar. Optimistic; in the Favorites view, unstarring drops the row.
  function onToggleFavorite(doc: Row) {
    const next = !doc.favorite
    setDocs((cur) => {
      if (!cur) return cur
      if (isFavorites && !next) return cur.filter((d) => d.id !== doc.id)
      return cur.map((d) => (d.id === doc.id ? { ...d, favorite: next } : d))
    })
    // Keep the search corpus in sync so the star reflects in results too.
    setAllDocs((cur) => cur?.map((d) => (d.id === doc.id ? { ...d, favorite: next } : d)) ?? null)
    setFavorite(doc.id, next).catch(reloadDocs)
  }

  // Pin/unpin (per-workspace quick access). Optimistic.
  function onTogglePin(doc: Row) {
    const next = !doc.pinned
    setDocs((cur) => cur?.map((d) => (d.id === doc.id ? { ...d, pinned: next } : d)) ?? null)
    setPin(doc.id, next).catch(reloadDocs)
  }

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

  async function onCopyCli() {
    await navigator.clipboard?.writeText('npm i -g @thedataco/mdocs').catch(() => {})
    setCliCopied(true)
    setTimeout(() => setCliCopied(false), 1800)
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
        <input
          className="topbar-search"
          type="search"
          placeholder="Search all documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={reloadAll}
          aria-label="Search all documents across workspaces"
        />
        <span className="spacer" />
        <button className="cli-install" onClick={onCopyCli} title="Copy the CLI install command">
          <span className="cli-cmd">npm i -g @thedataco/mdocs</span>
          {cliCopied ? (
            <span className="cli-check">✓</span>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <a
          className="icon-btn gh-link"
          href="https://github.com/TheDataCo/mdocs"
          target="_blank"
          rel="noreferrer"
          aria-label="mdocs CLI on GitHub"
          title="mdocs CLI on GitHub"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" role="img">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
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
            className={`ws-item ${isRecent ? 'active' : ''}`}
            onClick={() => setActiveId(RECENT)}
            title="Documents you've opened recently"
          >
            <span className="ws-glyph">◷</span>
            Recent
          </button>
          <button
            className={`ws-item ${isFavorites ? 'active' : ''}`}
            onClick={() => setActiveId(FAVORITES)}
            title="Documents you've starred"
          >
            <span className="ws-glyph">★</span>
            Favorites
          </button>
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
        </aside>

        <main className="content">
          {error && <p className="error">{error}</p>}
          {searching && (
            <>
              <div className="content-head">
                <h2>
                  {results.length} {results.length === 1 ? 'result' : 'results'} for “{q}”
                </h2>
              </div>
              <div className="doclist compact">
                {allDocs === null && !error && <p className="muted">Searching…</p>}
                {allDocs && results.length === 0 && (
                  <p className="muted">No documents match “{q}”.</p>
                )}
                {results.map((d) => (
                  <div key={d.id} className="row" onClick={() => navigate(`/d/${d.id}`)}>
                    <button
                      className={`star ${d.favorite ? 'on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleFavorite(d)
                      }}
                      title={d.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-label={d.favorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      {d.favorite ? '★' : '☆'}
                    </button>
                    <span className="doclist-title">{d.title}</span>
                    <span className="muted row-owner">{wsName(d.workspaceId)}</span>
                    <span className="muted row-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!searching && (
          <>
          <div className="content-head">
            <h2>
              {isTrash
                ? 'Recently deleted'
                : isShared
                  ? 'Shared'
                  : isFavorites
                    ? 'Favorites'
                    : isRecent
                      ? 'Recent'
                      : (active?.name ?? 'Documents')}
            </h2>
            <div className="content-actions">
              {active?.type === 'team' && !isShared && (
                <button className="btn" onClick={() => { setInviteOpen((o) => !o); setInviteMsg(null) }}>
                  Invite
                </button>
              )}
              {!isVirtual && (
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
          <div className="doclist compact">
            {docs === null && !error && <p className="muted">Loading…</p>}
            {docs && filtered.length === 0 && (
              <p className="muted">
                {query
                  ? 'No matches.'
                  : isFavorites
                    ? 'No favorites yet — star a document to keep it here.'
                    : isRecent
                      ? 'Nothing opened yet.'
                      : isShared
                        ? 'Nothing shared yet.'
                        : 'No documents yet — create one.'}
              </p>
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
                  draggable={!isVirtual}
                  onDragStart={() => setDragId(d.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => navigate(`/d/${d.id}`)}
                >
                  <span className="doclist-title">{d.title}</span>
                  {showOwner && (
                    <span className="muted row-owner">{d.ownerName || d.ownerEmail || '—'}</span>
                  )}
                  <div className="row-actions">
                    <button
                      className={`star ${d.favorite ? 'on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleFavorite(d)
                      }}
                      title={d.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-label={d.favorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      {d.favorite ? '★' : '☆'}
                    </button>
                    {!isVirtual && (
                      <button
                        className={`pin ${d.pinned ? 'on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onTogglePin(d)
                        }}
                        title={d.pinned ? 'Unpin from workspace' : 'Pin to workspace'}
                        aria-label={d.pinned ? 'Unpin' : 'Pin'}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill={d.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 17v5" />
                          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <span className="muted row-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                  {!isVirtual && (
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
          </>
          )}
        </main>
      </div>
    </>
  )
}
