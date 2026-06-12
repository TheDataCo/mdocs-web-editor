import { createHash, randomBytes } from 'node:crypto'
import { sql } from './db/index.js'
import type { Principal } from './auth.js'

function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

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
  // A doc with any per-doc share lives in the Shared view only (single instance),
  // so it's excluded from its home workspace listing.
  if (workspaceId) {
    return sql<DocRow[]>`
      select d.id, d.title, d.workspace_id, d.created_at, d.updated_at from docs d
      join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = ${principal.userId}
      where d.workspace_id = ${workspaceId} and d.deleted_at is null
        and not exists (select 1 from doc_access a where a.doc_id = d.id)
      order by d.updated_at desc
    `
  }
  // All docs in the user's workspaces (shared docs excluded — they're in Shared).
  return sql<DocRow[]>`
    select d.id, d.title, d.workspace_id, d.created_at, d.updated_at from docs d
    where d.deleted_at is null
      and d.workspace_id in (select workspace_id from workspace_members where user_id = ${principal.userId})
      and not exists (select 1 from doc_access a where a.doc_id = d.id)
    order by d.updated_at desc
  `
}

export interface SharedDocRow extends DocRow {
  owner_email: string | null
  owner_name: string | null
}

/**
 * The "Shared" view: docs explicitly shared WITH this user (via doc_access), plus
 * docs this user owns that they've shared OUT. Includes the owner for display.
 */
export async function listSharedDocs(userId: string): Promise<SharedDocRow[]> {
  return sql<SharedDocRow[]>`
    select distinct d.id, d.title, d.workspace_id, d.created_at, d.updated_at,
      ou.email as owner_email, ou.name as owner_name
    from docs d
    left join users ou on ou.id = d.owner_id
    where d.deleted_at is null and (
      d.id in (select doc_id from doc_access where user_id = ${userId})
      or (d.owner_id = ${userId} and exists (select 1 from doc_access a where a.doc_id = d.id))
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

/** Owner of a doc (for resolving the owner's plan when capping collaborators). */
export async function docOwnerId(docId: string): Promise<string | null> {
  const [row] = await sql<{ owner_id: string | null }[]>`select owner_id from docs where id = ${docId}`
  return row?.owner_id ?? null
}

/** Distinct people granted per-doc access (email shares + redeemed links). */
export async function countDocCollaborators(docId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(distinct user_id)::int as n from doc_access where doc_id = ${docId}
  `
  return row?.n ?? 0
}

export async function hasDocShare(docId: string, userId: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists(select 1 from doc_access where doc_id = ${docId} and user_id = ${userId}) as ok
  `
  return row?.ok ?? false
}

/** Whether the principal may open (view) a doc: workspace membership or any share. */
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

/** Whether the principal may edit (write): workspace member or a non-viewer share. */
export async function canEdit(principal: Principal, docId: string): Promise<boolean> {
  if (principal.kind === 'service') return true
  const [row] = await sql<{ ok: boolean }[]>`
    select exists(
      select 1 from docs d where d.id = ${docId} and d.deleted_at is null and (
        d.workspace_id in (select workspace_id from workspace_members where user_id = ${principal.userId})
        or d.id in (
          select doc_id from doc_access where user_id = ${principal.userId} and role in ('owner','editor')
        )
      )
    ) as ok
  `
  return row?.ok ?? false
}

/** Create a share link for a doc. Returns the plaintext token (only the hash is stored). */
export async function createLink(docId: string, role: 'viewer' | 'editor', createdBy: string): Promise<string> {
  const token = randomBytes(18).toString('base64url')
  await sql`
    insert into link_shares (doc_id, token_hash, role, created_by)
    values (${docId}, ${hashShareToken(token)}, ${role}, ${createdBy})
  `
  return token
}

/** Redeem a share link: grant the user doc_access at the link's role (never downgrades). */
export async function redeemLink(docId: string, token: string, userId: string): Promise<boolean> {
  const [link] = await sql<{ role: string }[]>`
    select role from link_shares
    where doc_id = ${docId} and token_hash = ${hashShareToken(token)}
      and revoked_at is null and (expires_at is null or expires_at > now())
  `
  if (!link) return false
  await sql`
    insert into doc_access (doc_id, user_id, role) values (${docId}, ${userId}, ${link.role})
    on conflict (doc_id, user_id) do update set
      role = case when doc_access.role = 'viewer' then excluded.role else doc_access.role end
  `
  return true
}
