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

/** Doc ids this user has starred — used to annotate listings with `favorite`. */
export async function favoriteDocIds(userId: string): Promise<Set<string>> {
  const rows = await sql<{ doc_id: string }[]>`
    select doc_id from doc_favorites where user_id = ${userId}
  `
  return new Set(rows.map((r) => r.doc_id))
}

/** Star/unstar a doc for a user (idempotent). Caller checks access first. */
export async function setFavorite(userId: string, docId: string, on: boolean): Promise<void> {
  if (on) {
    await sql`
      insert into doc_favorites (user_id, doc_id) values (${userId}, ${docId})
      on conflict (user_id, doc_id) do nothing
    `
  } else {
    await sql`delete from doc_favorites where user_id = ${userId} and doc_id = ${docId}`
  }
}

/** The "Favorites" view: starred docs the user can still access (owner included). */
export async function listFavoriteDocs(userId: string): Promise<SharedDocRow[]> {
  return sql<SharedDocRow[]>`
    select d.id, d.title, d.workspace_id, d.created_at, d.updated_at,
      ou.email as owner_email, ou.name as owner_name
    from doc_favorites f
    join docs d on d.id = f.doc_id and d.deleted_at is null
    left join users ou on ou.id = d.owner_id
    where f.user_id = ${userId} and (
      d.workspace_id in (select workspace_id from workspace_members where user_id = ${userId})
      or d.id in (select doc_id from doc_access where user_id = ${userId})
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

export interface TrashedDocRow {
  id: string
  title: string
  workspace_id: string | null
  workspace_name: string
  deleted_at: string
}

/**
 * Deleted docs visible to this user (member of the doc's workspace), within the
 * retention window. Docs that went down WITH a deleted workspace are excluded
 * (they're represented by the workspace's own trash entry), but docs deleted
 * separately still show even if their workspace is deleted too — nothing ever
 * silently vanishes from the trash.
 */
export async function listTrashedDocs(userId: string, days: number): Promise<TrashedDocRow[]> {
  return sql<TrashedDocRow[]>`
    select d.id, d.title, d.workspace_id, w.name as workspace_name, d.deleted_at
    from docs d
    join workspaces w on w.id = d.workspace_id
      and (w.deleted_at is null or d.deleted_at <> w.deleted_at)
    join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = ${userId}
    where d.deleted_at is not null
      and d.deleted_at > now() - make_interval(days => ${days})
    order by d.deleted_at desc
  `
}

/** Can this user still see a trashed doc (member, inside the window)? Unlike
 * the trash listing, docs inside deleted workspaces count — the CLI can view
 * them individually. */
export async function isTrashedDocVisible(id: string, userId: string, days: number): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists(
      select 1 from docs d
      join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = ${userId}
      where d.id = ${id} and d.deleted_at is not null
        and d.deleted_at > now() - make_interval(days => ${days})
    ) as ok
  `
  return row?.ok ?? false
}

/** Restore a deleted doc (workspace member only, inside the retention window).
 * If its home workspace is deleted, that comes back too — a restored doc must
 * be reachable. */
export async function restoreDoc(id: string, userId: string, days: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; workspace_id: string | null }[]>`
      update docs d set deleted_at = null, updated_at = now()
      from workspace_members m
      where d.id = ${id}
        and m.workspace_id = d.workspace_id and m.user_id = ${userId}
        and d.deleted_at is not null
        and d.deleted_at > now() - make_interval(days => ${days})
      returning d.id, d.workspace_id
    `
    if (!row) return false
    await tx`
      update workspaces set deleted_at = null, updated_at = now()
      where id = ${row.workspace_id} and deleted_at is not null
    `
    return true
  })
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

/** The role of a valid (unrevoked, unexpired) share link, or null. Lets a
 * logged-out visitor read a doc via the link without an account. */
export async function shareLinkRole(docId: string, token: string): Promise<'viewer' | 'editor' | null> {
  if (!token) return null
  const [link] = await sql<{ role: 'viewer' | 'editor' }[]>`
    select role from link_shares
    where doc_id = ${docId} and token_hash = ${hashShareToken(token)}
      and revoked_at is null and (expires_at is null or expires_at > now())
  `
  return link?.role ?? null
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
