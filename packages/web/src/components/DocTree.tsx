import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createDoc,
  type DocListItem,
  listDocs,
  listFavorites,
  listRecent,
  listShared,
  listWorkspaces,
  setPin,
  type SharedDoc,
  type Workspace,
} from '../api'
import { Wordmark } from './Wordmark'

const SHARED = '__shared__'

function nextUntitled(docs: { title: string }[]): string {
  const nums = docs
    .map((d) => (d.title === 'Untitled' ? 1 : Number(d.title.match(/^Untitled (\d+)$/)?.[1] ?? 0)))
    .filter((n) => n > 0)
  return nums.length ? `Untitled ${Math.max(...nums) + 1}` : 'Untitled'
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}

// Left navigation tree shown inside the editor. Filesystem-style: the root lists
// Recent + Favorites + the workspaces (and Shared) as folders; opening a doc
// focuses its workspace folder so you see its siblings, with a breadcrumb back to
// the root. Pinned docs float to the top of their workspace folder.
export function DocTree({ activeDocId, activeTitle }: { activeDocId?: string; activeTitle?: string }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [docs, setDocs] = useState<DocListItem[]>([])
  const [shared, setShared] = useState<SharedDoc[]>([])
  const [favorites, setFavorites] = useState<SharedDoc[]>([])
  const [recent, setRecent] = useState<SharedDoc[]>([])
  const [focus, setFocus] = useState<string | null>(null) // null = root; ws id or SHARED
  const [query, setQuery] = useState('')
  const focusedDocRef = useRef<string | undefined>(undefined)
  const navigate = useNavigate()

  const q = query.trim().toLowerCase()
  const matches = (d: { title: string }) => !q || (d.title || 'Untitled').toLowerCase().includes(q)

  const refresh = useCallback(async () => {
    const [ws, ds, sh, fav, rec] = await Promise.all([
      listWorkspaces(),
      listDocs(),
      listShared(),
      listFavorites(),
      listRecent(),
    ])
    setWorkspaces(ws)
    setDocs(ds)
    setShared(sh)
    setFavorites(fav)
    setRecent(rec)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Focus the active doc's home folder when you open it (once per doc), but leave
  // the user free to navigate elsewhere afterward.
  useEffect(() => {
    if (!activeDocId || focusedDocRef.current === activeDocId) return
    const inWs = docs.find((d) => d.id === activeDocId)
    if (inWs) {
      setFocus(inWs.workspaceId ?? null)
      focusedDocRef.current = activeDocId
    } else if (shared.find((d) => d.id === activeDocId)) {
      setFocus(SHARED)
      focusedDocRef.current = activeDocId
    }
  }, [activeDocId, docs, shared])

  async function onNewDoc(workspaceId: string) {
    const wsDocs = docs.filter((d) => d.workspaceId === workspaceId)
    const doc = await createDoc(nextUntitled(wsDocs), workspaceId)
    setDocs((cur) => [{ ...doc, favorite: false, pinned: false }, ...cur])
    navigate(`/d/${doc.id}`)
  }

  function onTogglePin(d: DocListItem) {
    const next = !d.pinned
    setDocs((cur) => cur.map((x) => (x.id === d.id ? { ...x, pinned: next } : x)))
    setPin(d.id, next).catch(refresh)
  }

  const title = (d: { id: string; title: string }) =>
    (d.id === activeDocId && activeTitle != null ? activeTitle : d.title) || 'Untitled'

  // A doc row with an optional pin toggle (pinnable = workspace docs only).
  function DocRow({ d, pinnable }: { d: DocListItem; pinnable?: boolean }) {
    return (
      <div className="tree-row">
        <button
          className={`tree-doc ${d.id === activeDocId ? 'active' : ''}`}
          onClick={() => navigate(`/d/${d.id}`)}
        >
          {title(d)}
        </button>
        {pinnable && (
          <button
            className={`tree-pin ${d.pinned ? 'on' : ''}`}
            onClick={() => onTogglePin(d)}
            title={d.pinned ? 'Unpin from workspace' : 'Pin to workspace'}
            aria-label={d.pinned ? 'Unpin' : 'Pin'}
          >
            <PinIcon filled={d.pinned} />
          </button>
        )}
      </div>
    )
  }

  // --- Search: flat results across every doc you can reach. ---
  if (q) {
    const hits = [...docs, ...shared].filter(matches)
    const wsName = (id: string | null) => workspaces.find((w) => w.id === id)?.name
    return (
      <aside className="tree">
        <Head />
        <Search value={query} onChange={setQuery} />
        <div className="tree-body">
          {hits.length === 0 && <div className="tree-empty">No matches</div>}
          {hits.map((d) => (
            <div key={d.id} className="tree-row">
              <button
                className={`tree-doc ${d.id === activeDocId ? 'active' : ''}`}
                onClick={() => navigate(`/d/${d.id}`)}
                title={wsName(d.workspaceId) ?? 'Shared'}
              >
                {title(d)}
              </button>
            </div>
          ))}
        </div>
      </aside>
    )
  }

  // --- Folder view: inside a workspace (or Shared). ---
  if (focus !== null) {
    const ws = workspaces.find((w) => w.id === focus)
    const folderName = focus === SHARED ? 'Shared' : (ws?.name ?? 'Workspace')
    const wsDocs = docs.filter((d) => d.workspaceId === focus)
    const pinned = wsDocs.filter((d) => d.pinned)
    const rest = wsDocs.filter((d) => !d.pinned)
    return (
      <aside className="tree">
        <Head />
        <Search value={query} onChange={setQuery} />
        <div className="tree-body">
          <button className="tree-back" onClick={() => setFocus(null)}>
            ‹ All workspaces
          </button>
          <div className="tree-folder-head">
            <span className="tree-folder-glyph">{focus === SHARED ? '⬡' : '•'}</span>
            <span className="tree-folder-title">{folderName}</span>
            {ws && (
              <button className="tree-add" title="New doc" onClick={() => onNewDoc(ws.id)}>
                +
              </button>
            )}
          </div>

          {pinned.length > 0 && (
            <>
              <div className="tree-section-label">Pinned</div>
              {pinned.map((d) => (
                <DocRow key={d.id} d={d} pinnable />
              ))}
              <div className="tree-section-label">All docs</div>
            </>
          )}

          {focus === SHARED
            ? shared.length === 0
              ? <div className="tree-empty">Nothing shared</div>
              : shared.map((d) => <DocRow key={d.id} d={d} />)
            : rest.length === 0 && pinned.length === 0
              ? <div className="tree-empty">No docs</div>
              : rest.map((d) => <DocRow key={d.id} d={d} pinnable />)}
        </div>
      </aside>
    )
  }

  // --- Root view: Recent + Favorites + workspaces (folders) + Shared. ---
  return (
    <aside className="tree">
      <Head />
      <Search value={query} onChange={setQuery} />
      <div className="tree-body">
        {recent.length > 0 && (
          <div className="tree-section">
            <div className="tree-section-label">Recent</div>
            {recent.slice(0, 8).map((d) => (
              <DocRow key={d.id} d={d} />
            ))}
          </div>
        )}

        {favorites.length > 0 && (
          <div className="tree-section">
            <div className="tree-section-label">Favorites</div>
            {favorites.map((d) => (
              <DocRow key={d.id} d={d} />
            ))}
          </div>
        )}

        <div className="tree-section-label">Workspaces</div>
        {workspaces.map((w) => {
          const count = docs.filter((d) => d.workspaceId === w.id).length
          return (
            <button key={w.id} className="tree-folder" onClick={() => setFocus(w.id)}>
              <span className="tree-folder-glyph">•</span>
              <span className="tree-folder-title">{w.name}</span>
              {count > 0 && <span className="tree-folder-count">{count}</span>}
              <span className="tree-folder-chevron">›</span>
            </button>
          )
        })}
        <button className="tree-folder" onClick={() => setFocus(SHARED)}>
          <span className="tree-folder-glyph">⬡</span>
          <span className="tree-folder-title">Shared</span>
          {shared.length > 0 && <span className="tree-folder-count">{shared.length}</span>}
          <span className="tree-folder-chevron">›</span>
        </button>
      </div>
    </aside>
  )
}

function Head() {
  return (
    <div className="tree-head">
      <Wordmark />
    </div>
  )
}

function Search({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="tree-search">
      <input type="search" placeholder="Search docs…" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
