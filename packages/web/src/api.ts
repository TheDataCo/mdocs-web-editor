import type { DocMeta } from '@mdocs/core'
import { getToken } from './auth'
import { API_URL } from './config'

interface ApiDoc {
  id: string
  title: string
  workspace_id: string | null
  created_at: string
  updated_at: string
}

function toMeta(d: ApiDoc): DocMeta {
  return {
    id: d.id,
    title: d.title,
    workspaceId: d.workspace_id ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }
}

async function request(path: string, init?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    // Prefer the server's human-readable error message (e.g. plan limits).
    const text = await res.text()
    let msg = `API ${res.status}`
    try {
      msg = JSON.parse(text)?.error?.message ?? msg
    } catch {
      if (text) msg = `${msg}: ${text}`
    }
    throw new Error(msg)
  }
  return res.json()
}

// In-editor AI assistant (server-side OpenRouter). 'generate' returns markdown
// to insert; 'rewrite' returns a replacement for the supplied selection.
export async function aiAssist(opts: {
  mode: 'generate' | 'rewrite'
  instruction: string
  selection?: string
  document?: string
}): Promise<string> {
  const { output } = await request('/api/ai', { method: 'POST', body: JSON.stringify(opts) })
  return output
}

export interface Workspace {
  id: string
  type: 'personal' | 'team'
  name: string
  role: string
}

export interface Member {
  user_id: string
  email: string
  name: string | null
  role: string
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const { workspaces } = await request('/api/workspaces')
  return workspaces
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const { workspace } = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
  return workspace
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await request(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export async function deleteWorkspace(id: string): Promise<void> {
  await request(`/api/workspaces/${id}`, { method: 'DELETE' })
}

export interface TrashedDoc {
  id: string
  title: string
  workspaceName: string
  deletedAt: string
}

export interface TrashedWorkspace {
  id: string
  name: string
  docCount: number
  deletedAt: string
}

export interface Trash {
  docs: TrashedDoc[]
  workspaces: TrashedWorkspace[]
  retentionDays: number
}

export async function listTrash(): Promise<Trash> {
  const { docs, workspaces, retentionDays } = await request('/api/trash')
  return {
    docs: docs.map((d: { id: string; title: string; workspace_name: string; deleted_at: string }) => ({
      id: d.id,
      title: d.title,
      workspaceName: d.workspace_name,
      deletedAt: d.deleted_at,
    })),
    workspaces: workspaces.map((w: { id: string; name: string; doc_count: number; deleted_at: string }) => ({
      id: w.id,
      name: w.name,
      docCount: w.doc_count,
      deletedAt: w.deleted_at,
    })),
    retentionDays,
  }
}

export async function restoreDoc(id: string): Promise<void> {
  await request(`/api/docs/${id}/restore`, { method: 'POST' })
}

export async function restoreWorkspace(id: string): Promise<void> {
  await request(`/api/workspaces/${id}/restore`, { method: 'POST' })
}

export async function listMembers(workspaceId: string): Promise<Member[]> {
  const { members } = await request(`/api/workspaces/${workspaceId}/members`)
  return members
}

export async function inviteMember(workspaceId: string, email: string, role = 'member'): Promise<{ status: string }> {
  const { result } = await request(`/api/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
  return result
}

export interface DocListItem extends DocMeta {
  favorite: boolean
  pinned: boolean
}

export async function listDocs(workspaceId?: string): Promise<DocListItem[]> {
  const { docs } = await request(`/api/docs${workspaceId ? `?workspace=${workspaceId}` : ''}`)
  return docs.map((d: ApiDoc & { favorite?: boolean; pinned?: boolean }) => ({
    ...toMeta(d),
    favorite: !!d.favorite,
    pinned: !!d.pinned,
  }))
}

export interface SharedDoc extends DocListItem {
  ownerEmail: string | null
  ownerName: string | null
}

function toSharedDoc(
  d: ApiDoc & { owner_email?: string; owner_name?: string; favorite?: boolean; pinned?: boolean },
): SharedDoc {
  return {
    ...toMeta(d),
    favorite: !!d.favorite,
    pinned: !!d.pinned,
    ownerEmail: d.owner_email ?? null,
    ownerName: d.owner_name ?? null,
  }
}

export async function listShared(): Promise<SharedDoc[]> {
  const { docs } = await request('/api/docs/shared')
  return docs.map(toSharedDoc)
}

export async function listFavorites(): Promise<SharedDoc[]> {
  const { docs } = await request('/api/docs/favorites')
  return docs.map(toSharedDoc)
}

export async function listRecent(): Promise<SharedDoc[]> {
  const { docs } = await request('/api/docs/recent')
  return docs.map(toSharedDoc)
}

export async function setFavorite(id: string, on: boolean): Promise<void> {
  await request(`/api/docs/${id}/favorite`, { method: on ? 'PUT' : 'DELETE' })
}

export async function setPin(id: string, on: boolean): Promise<void> {
  await request(`/api/docs/${id}/pin`, { method: on ? 'PUT' : 'DELETE' })
}

export async function createDoc(title: string, workspaceId?: string): Promise<DocMeta> {
  const { doc } = await request('/api/docs', {
    method: 'POST',
    body: JSON.stringify({ title, workspaceId }),
  })
  return toMeta(doc)
}

export interface DocDetail extends DocMeta {
  canEdit: boolean
  favorite: boolean
  pinned: boolean
}

export interface PlanInfo {
  planName: string
  entitlements: {
    maxDocs: number | null
    teamWorkspaces: boolean
    maxCollaboratorsPerDoc: number | null
    maxMembersPerWorkspace: number | null
    versionHistory: boolean
    apiCallsPerMonth: number | null
    trashRetentionDays: number
  }
  usage: { docs: number; workspaces: number; apiCalls: number }
}

export async function getPlan(): Promise<PlanInfo | null> {
  const res = await request('/api/me/plan')
  return res.planName ? res : null
}

export interface ActivityItem {
  method: string
  path: string
  status: number
  created_at: string
}

export async function getActivity(): Promise<ActivityItem[]> {
  const { activity } = await request('/api/me/activity')
  return activity
}

export async function getDoc(id: string): Promise<DocDetail> {
  const { doc, canEdit, favorite, pinned } = await request(`/api/docs/${id}`)
  return { ...toMeta(doc), canEdit, favorite: !!favorite, pinned: !!pinned }
}

export interface SharedDocView {
  id: string
  title: string
  content: string
  role: 'viewer' | 'editor'
}

// Public read of a doc via a share-link token — no auth header (the endpoint is
// allowlisted server-side). Lets a logged-out visitor view before signing in.
export async function getSharedDoc(id: string, token: string): Promise<SharedDocView> {
  const res = await fetch(`${API_URL}/api/share/${id}?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error(`share ${res.status}`)
  const { doc, content, role } = await res.json()
  return { id: doc.id, title: doc.title, content, role }
}

export async function createLink(id: string, role: 'viewer' | 'editor'): Promise<string> {
  const { token } = await request(`/api/docs/${id}/links`, { method: 'POST', body: JSON.stringify({ role }) })
  return token
}

export interface DocVersion {
  id: string
  n: number
  source: string
  message: string | null
  authorEmail: string | null
  createdAt: string
}

export async function listVersions(id: string): Promise<DocVersion[]> {
  const { versions } = await request(`/api/docs/${id}/versions`)
  return versions
}

export async function getVersionContent(id: string, n: number): Promise<string> {
  const res = await fetch(`${API_URL}/api/docs/${id}/versions/${n}`, {
    headers: { Authorization: `Bearer ${await getToken()}` },
  })
  if (!res.ok) throw new Error(`version ${res.status}`)
  return res.text()
}

export async function redeemLink(id: string, token: string): Promise<boolean> {
  try {
    await request(`/api/docs/${id}/links/redeem`, { method: 'POST', body: JSON.stringify({ token }) })
    return true
  } catch {
    return false
  }
}

export async function approveCliAuth(userCode: string): Promise<boolean> {
  try {
    await request('/api/cli/auth/approve', { method: 'POST', body: JSON.stringify({ user_code: userCode }) })
    return true
  } catch {
    return false
  }
}

export async function renameDoc(id: string, title: string): Promise<DocMeta> {
  const { doc } = await request(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  return toMeta(doc)
}

export async function moveDoc(id: string, workspaceId: string): Promise<DocMeta> {
  const { doc } = await request(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ workspaceId }) })
  return toMeta(doc)
}

export async function deleteDoc(id: string): Promise<void> {
  await request(`/api/docs/${id}`, { method: 'DELETE' })
}

export async function shareDoc(id: string, email: string): Promise<{ status: string }> {
  const { result } = await request(`/api/docs/${id}/share`, { method: 'POST', body: JSON.stringify({ email }) })
  return result
}

export interface CliToken {
  id: string
  name: string
  last_used_at: string | null
  created_at: string
}

export async function listTokens(): Promise<CliToken[]> {
  const { tokens } = await request('/api/tokens')
  return tokens
}

export async function createToken(name: string): Promise<{ id: string; token: string }> {
  const { token } = await request('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) })
  return token
}

export async function revokeToken(id: string): Promise<void> {
  await request(`/api/tokens/${id}`, { method: 'DELETE' })
}
