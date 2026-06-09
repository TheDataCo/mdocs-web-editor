import { sql } from './db/index.js'
import type { Principal } from './auth.js'

export interface DocRow {
  id: string
  title: string
  workspace_id: string | null
  created_at: string
  updated_at: string
}

/**
 * Docs the principal can see: service → all; user → docs in any workspace they
 * belong to, plus docs explicitly shared with them via doc_access.
 */
export async function listDocs(principal: Principal, workspaceId?: string): Promise<DocRow[]> {
  if (principal.kind === 'service') {
    return sql<DocRow[]>`
      select id, title, workspace_id, created_at, updated_at from docs
      where deleted_at is null order by updated_at desc
    `
  }
  if (workspaceId) {
    return sql<DocRow[]>`
      select d.id, d.title, d.workspace_id, d.created_at, d.updated_at from docs d
      join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = ${principal.userId}
      where d.workspace_id = ${workspaceId} and d.deleted_at is null
      order by d.updated_at desc
    `
  }
  // All accessible docs (workspace membership ∪ direct shares).
  return sql<DocRow[]>`
    select d.id, d.title, d.workspace_id, d.created_at, d.updated_at from docs d
    where d.deleted_at is null and (
      d.workspace_id in (select workspace_id from workspace_members where user_id = ${principal.userId})
      or d.id in (select doc_id from doc_access where user_id = ${principal.userId})
    )
    order by d.updated_at desc
  `
}

export async function getDoc(id: string): Promise<DocRow | undefined> {
  const [row] = await sql<DocRow[]>`
    select id, title, workspace_id, created_at, updated_at from docs
    where id = ${id} and deleted_at is null
  `
  return row
}

export async function docExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists(select 1 from docs where id = ${id} and deleted_at is null) as exists
  `
  return row?.exists ?? false
}

export async function createDoc(title: string, workspaceId: string, createdBy: string): Promise<DocRow> {
  const [doc] = await sql<DocRow[]>`
    insert into docs (title, workspace_id, owner_id) values (${title}, ${workspaceId}, ${createdBy})
    returning id, title, workspace_id, created_at, updated_at
  `
  return doc!
}

export async function renameDoc(id: string, title: string): Promise<DocRow | undefined> {
  const [row] = await sql<DocRow[]>`
    update docs set title = ${title}, updated_at = now()
    where id = ${id} and deleted_at is null
    returning id, title, workspace_id, created_at, updated_at
  `
  return row
}

export async function softDeleteDoc(id: string): Promise<void> {
  await sql`update docs set deleted_at = now() where id = ${id}`
}

export async function moveDoc(id: string, workspaceId: string): Promise<DocRow | undefined> {
  const [row] = await sql<DocRow[]>`
    update docs set workspace_id = ${workspaceId}, updated_at = now()
    where id = ${id} and deleted_at is null
    returning id, title, workspace_id, created_at, updated_at
  `
  return row
}

/** Whether the principal may open/edit a doc: workspace membership or a direct share. */
export async function canAccess(principal: Principal, docId: string): Promise<boolean> {
  if (principal.kind === 'service') return true
  const [row] = await sql<{ ok: boolean }[]>`
    select exists(
      select 1 from docs d where d.id = ${docId} and d.deleted_at is null and (
        d.workspace_id in (select workspace_id from workspace_members where user_id = ${principal.userId})
        or d.id in (select doc_id from doc_access where user_id = ${principal.userId})
      )
    ) as ok
  `
  return row?.ok ?? false
}
