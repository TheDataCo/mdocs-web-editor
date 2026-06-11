import { randomUUID } from 'node:crypto'
import { type CommentValue, DOC_COMMENTS_FIELD } from '@mdocs/core'
import type { Hocuspocus } from '@hocuspocus/server'
import type * as Y from 'yjs'
import { sql } from './db/index.js'
import type { Principal } from './auth.js'

// Comments are authored into the doc's Yjs Y.Map (so they sync live and anchor
// natively); this module mirrors that map into Postgres so the CLI/agents can
// list and resolve over HTTP.

function toTimestamp(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null
}

export async function upsert(docId: string, c: CommentValue): Promise<void> {
  await sql`
    insert into comments (id, doc_id, author_id, author_name, body, anchor_start, anchor_end,
      excerpt, parent_id, status, created_at_version, resolved_by, created_at, resolved_at)
    values (${c.id}, ${docId}, ${c.authorId}, ${c.authorName}, ${c.body}, ${c.anchorStart},
      ${c.anchorEnd}, ${c.excerpt}, ${c.parentId}, ${c.status},
      (select coalesce(max(n), 0) from doc_versions where doc_id = ${docId}),
      ${c.resolvedBy}, ${toTimestamp(c.createdAt) ?? sql`now()`}, ${toTimestamp(c.resolvedAt)})
    on conflict (id) do update set
      body = excluded.body, status = excluded.status, resolved_by = excluded.resolved_by,
      resolved_at = excluded.resolved_at, anchor_start = excluded.anchor_start,
      anchor_end = excluded.anchor_end, excerpt = excluded.excerpt
  `
}

/** Attach a mirror: observe the doc's comments Y.Map and keep Postgres in sync. */
export function attachCommentMirror(docId: string, doc: Y.Doc): void {
  const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
  const sync = (keys: Iterable<string>) => {
    for (const id of keys) {
      const value = ymap.get(id)
      if (value) void upsert(docId, value)
      else void sql`delete from comments where id = ${id}`
    }
  }
  ymap.observe((event) => sync(event.keys.keys()))
  // Initial reconcile (in case rows drifted while the doc was unloaded).
  if (ymap.size > 0) sync(ymap.keys())
}

export async function listComments(docId: string, status?: string) {
  if (status) {
    return sql`
      select id, author_id, author_name, body, anchor_start, anchor_end, excerpt,
        parent_id, status, created_at_version, created_at, resolved_at
      from comments where doc_id = ${docId} and status = ${status} order by created_at asc
    `
  }
  return sql`
    select id, author_id, author_name, body, anchor_start, anchor_end, excerpt,
      parent_id, status, created_at_version, created_at, resolved_at
    from comments where doc_id = ${docId} order by created_at asc
  `
}

/** Build a new comment value (document-level unless an anchor is supplied). */
export function newComment(principal: Principal, body: string, excerpt = '', parentId: string | null = null): CommentValue {
  return {
    id: randomUUID(),
    authorId: principal.kind === 'user' ? principal.userId : null,
    authorName: null,
    body,
    anchorStart: null,
    anchorEnd: null,
    excerpt,
    parentId,
    status: 'open',
    resolvedBy: null,
    createdAt: Date.now(),
    resolvedAt: null,
  }
}

/** Write a comment into the live doc's Y.Map via a direct connection (mirrors to PG). */
export async function addCommentToDoc(hocuspocus: Hocuspocus, docId: string, comment: CommentValue): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(docId)
  try {
    await conn.transact((doc) => {
      doc.getMap<CommentValue>(DOC_COMMENTS_FIELD).set(comment.id, comment)
    })
  } finally {
    await conn.disconnect()
  }
  await upsert(docId, comment) // read-after-write for HTTP callers (observer also mirrors)
}

/** Resolve (or reopen) a comment in the live doc. Returns false if not found. */
export async function setCommentStatus(
  hocuspocus: Hocuspocus,
  docId: string,
  commentId: string,
  status: 'open' | 'resolved',
  principal: Principal,
): Promise<boolean> {
  let updated: CommentValue | null = null
  const conn = await hocuspocus.openDirectConnection(docId)
  try {
    await conn.transact((doc) => {
      const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
      const c = ymap.get(commentId)
      if (!c) return
      updated = {
        ...c,
        status,
        resolvedBy: status === 'resolved' && principal.kind === 'user' ? principal.userId : null,
        resolvedAt: status === 'resolved' ? Date.now() : null,
      }
      ymap.set(commentId, updated)
    })
  } finally {
    await conn.disconnect()
  }
  if (updated) await upsert(docId, updated) // read-after-write
  return updated !== null
}
