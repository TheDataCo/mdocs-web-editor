import type { DocMeta } from '@datadocs/core'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createDoc, listDocs, listWorkspaces, moveDoc, type Workspace } from '../api'
import { Wordmark } from './Wordmark'

function nextUntitled(docs: DocMeta[]): string {
  const nums = docs
    .map((d) => (d.title === 'Untitled' ? 1 : Number(d.title.match(/^Untitled (\d+)$/)?.[1] ?? 0)))
    .filter((n) => n > 0)
  return nums.length ? `Untitled ${Math.max(...nums) + 1}` : 'Untitled'
}

// Left navigation tree shown inside the editor: workspaces → docs, collapsible,
// create-in-place, current-doc highlight, drag a doc onto a workspace to move it.
export function DocTree({ activeDocId, activeTitle }: { activeDocId?: string; activeTitle?: string }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropWs, setDropWs] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const q = query.trim().toLowerCase()
  const matches = (d: DocMeta) => !q || d.title.toLowerCase().includes(q)

  const refresh = useCallback(async () => {
    const [ws, ds] = await Promise.all([listWorkspaces(), listDocs()])
    setWorkspaces(ws)
    setDocs(ds)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function toggle(id: string) {
    setCollapsed((c) => {
      const n = new Set(c)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  async function onNewDoc(workspaceId: string) {
    const wsDocs = docs.filter((d) => d.workspaceId === workspaceId)
    const doc = await createDoc(nextUntitled(wsDocs), workspaceId)
    setDocs((cur) => [doc, ...cur])
    navigate(`/d/${doc.id}`)
  }

  async function onDrop(workspaceId: string) {
    const id = dragId
    setDropWs(null)
    setDragId(null)
    if (!id) return
    const moving = docs.find((d) => d.id === id)
    if (!moving || moving.workspaceId === workspaceId) return
    setDocs((cur) => cur.map((d) => (d.id === id ? { ...d, workspaceId } : d))) // optimistic
    moveDoc(id, workspaceId).catch(() => refresh())
  }

  return (
    <aside className="tree">
      <div className="tree-head">
        <Wordmark />
      </div>
      <div className="tree-search">
        <input
          type="search"
          placeholder="Search docs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="tree-body">
        {workspaces.map((w) => {
          const wsDocs = docs.filter((d) => d.workspaceId === w.id && matches(d))
          // While searching, hide workspaces with no matches and force-expand the rest.
          if (q && wsDocs.length === 0) return null
          const isCollapsed = collapsed.has(w.id) && !q
          return (
            <div key={w.id} className="tree-ws">
              <div
                className={`tree-ws-head ${dropWs === w.id ? 'drop' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDropWs(w.id)
                }}
                onDragLeave={() => setDropWs((d) => (d === w.id ? null : d))}
                onDrop={() => onDrop(w.id)}
              >
                <button className="tree-twisty" onClick={() => toggle(w.id)}>
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <span className="tree-ws-name" onClick={() => toggle(w.id)}>
                  {w.type === 'personal' ? '•' : '⬡'} {w.name}
                </span>
                <button className="tree-add" title="New doc" onClick={() => onNewDoc(w.id)}>
                  +
                </button>
              </div>
              {!isCollapsed &&
                wsDocs.map((d) => (
                  <button
                    key={d.id}
                    className={`tree-doc ${d.id === activeDocId ? 'active' : ''} ${dragId === d.id ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => setDragId(d.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => navigate(`/d/${d.id}`)}
                  >
                    {(d.id === activeDocId && activeTitle != null ? activeTitle : d.title) || 'Untitled'}
                  </button>
                ))}
              {!isCollapsed && wsDocs.length === 0 && <div className="tree-empty">No docs</div>}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
