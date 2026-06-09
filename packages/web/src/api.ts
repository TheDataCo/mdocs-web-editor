import type { DocMeta } from '@datadocs/core'
import { getToken } from './auth'
import { API_URL } from './config'

interface ApiDoc {
  id: string
  title: string
  created_at: string
  updated_at: string
}

function toMeta(d: ApiDoc): DocMeta {
  return { id: d.id, title: d.title, createdAt: d.created_at, updatedAt: d.updated_at }
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
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  return res.json()
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

export async function listDocs(workspaceId?: string): Promise<DocMeta[]> {
  const { docs } = await request(`/api/docs${workspaceId ? `?workspace=${workspaceId}` : ''}`)
  return docs.map(toMeta)
}

export async function createDoc(title: string, workspaceId?: string): Promise<DocMeta> {
  const { doc } = await request('/api/docs', {
    method: 'POST',
    body: JSON.stringify({ title, workspaceId }),
  })
  return toMeta(doc)
}

export async function getDoc(id: string): Promise<DocMeta> {
  const { doc } = await request(`/api/docs/${id}`)
  return toMeta(doc)
}

export async function renameDoc(id: string, title: string): Promise<DocMeta> {
  const { doc } = await request(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
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
