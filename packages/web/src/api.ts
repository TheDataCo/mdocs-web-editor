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

export async function listDocs(): Promise<DocMeta[]> {
  const { docs } = await request('/api/docs')
  return docs.map(toMeta)
}

export async function createDoc(title: string): Promise<DocMeta> {
  const { doc } = await request('/api/docs', { method: 'POST', body: JSON.stringify({ title }) })
  return toMeta(doc)
}

export async function getDoc(id: string): Promise<DocMeta> {
  const { doc } = await request(`/api/docs/${id}`)
  return toMeta(doc)
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
