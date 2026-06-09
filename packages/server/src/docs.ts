import { sql } from './db/index.js'
import type { Principal } from './auth.js'

export interface DocRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/** Docs the principal can see: everything for a service token, else doc_access membership. */
export async function listDocs(principal: Principal): Promise<DocRow[]> {
  if (principal.kind === 'service') {
    return sql<DocRow[]>`
      select id, title, created_at, updated_at from docs
      where deleted_at is null order by updated_at desc
    `
  }
  return sql<DocRow[]>`
    select d.id, d.title, d.created_at, d.updated_at from docs d
    join doc_access a on a.doc_id = d.id and a.user_id = ${principal.userId}
    where d.deleted_at is null order by d.updated_at desc
  `
}

export async function getDoc(id: string): Promise<DocRow | undefined> {
  const [row] = await sql<DocRow[]>`
    select id, title, created_at, updated_at from docs
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

export async function createDoc(title: string, ownerId: string): Promise<DocRow> {
  return sql.begin(async (tx) => {
    const [doc] = await tx<DocRow[]>`
      insert into docs (title, owner_id) values (${title}, ${ownerId})
      returning id, title, created_at, updated_at
    `
    await tx`
      insert into doc_access (doc_id, user_id, role) values (${doc!.id}, ${ownerId}, 'owner')
    `
    return doc!
  })
}

/** Whether the principal may open/edit a doc. Service → always. */
export async function canAccess(principal: Principal, docId: string): Promise<boolean> {
  if (principal.kind === 'service') return true
  const [row] = await sql<{ exists: boolean }[]>`
    select exists(
      select 1 from doc_access where doc_id = ${docId} and user_id = ${principal.userId}
    ) as exists
  `
  return row?.exists ?? false
}

/** Anyone-with-the-link join: first time a signed-in user opens a doc, add them as editor. */
export async function joinDoc(userId: string, docId: string): Promise<void> {
  await sql`
    insert into doc_access (doc_id, user_id, role) values (${docId}, ${userId}, 'editor')
    on conflict (doc_id, user_id) do nothing
  `
}
