import * as Y from 'yjs'
import { sql } from './db/index.js'

// Persistence invariants (see PLAN.md):
// - per-doc monotonic seq, assigned under a per-doc advisory xact lock
// - append is transactional; broadcast happens only after Hocuspocus has the
//   update in memory AND we've awaited the append (append-then-broadcast)
// - compaction writes a snapshot; it never deletes doc_updates rows
//
// Note on snapshot bounds: a snapshot taken from the in-memory doc may contain
// changes whose log rows are still in flight, making upto_seq conservative
// (too low). That's safe: replaying those updates on top of the snapshot is a
// no-op (Yjs updates are idempotent). upto_seq can never be too high because
// it's read under the same lock that serializes appends.

export interface UpdateMeta {
  origin: 'websocket' | 'http'
  authorId?: string | null
  clientId?: string | null
  requestId?: string | null
}

/** Ensure a docs row exists (milestone-1 lazy creation; real CRUD comes with the API). */
export async function ensureDoc(docId: string): Promise<void> {
  await sql`
    insert into docs (id, title)
    values (${docId}, 'Untitled')
    on conflict (id) do nothing
  `
}

/** Load persisted state for a doc: latest snapshot + tail of the update log. */
export async function loadDocState(docId: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const [snap] = await sql<{ snapshot: Uint8Array; upto_seq: string }[]>`
    select snapshot, upto_seq from doc_snapshots where doc_id = ${docId}
  `
  const uptoSeq = snap ? Number(snap.upto_seq) : 0
  if (snap) Y.applyUpdate(doc, snap.snapshot)
  const updates = await sql<{ update: Uint8Array }[]>`
    select update from doc_updates
    where doc_id = ${docId} and seq > ${uptoSeq}
    order by seq asc
  `
  for (const row of updates) Y.applyUpdate(doc, row.update)
  return doc
}

/** Append one Yjs update to the log with a per-doc monotonic seq. */
export async function appendUpdate(
  docId: string,
  update: Uint8Array,
  meta: UpdateMeta,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${docId}::text, 0))`
    await tx`
      insert into doc_updates (doc_id, seq, update, author_id, origin, client_id, request_id)
      values (
        ${docId},
        coalesce((select max(seq) from doc_updates where doc_id = ${docId}), 0) + 1,
        ${update},
        ${meta.authorId ?? null},
        ${meta.origin},
        ${meta.clientId ?? null},
        ${meta.requestId ?? null}
      )
    `
  })
}

/** Compact: write the current doc state as the latest snapshot. Never deletes updates. */
export async function saveSnapshot(docId: string, doc: Y.Doc): Promise<void> {
  const snapshot = Y.encodeStateAsUpdate(doc)
  const stateVector = Y.encodeStateVector(doc)
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${docId}::text, 0))`
    const [row] = await tx<{ max: string }[]>`
      select coalesce(max(seq), 0) as max from doc_updates where doc_id = ${docId}
    `
    await tx`
      insert into doc_snapshots (doc_id, snapshot, state_vector, upto_seq)
      values (${docId}, ${snapshot}, ${stateVector}, ${Number(row!.max)})
      on conflict (doc_id) do update set
        snapshot = excluded.snapshot,
        state_vector = excluded.state_vector,
        upto_seq = excluded.upto_seq,
        created_at = now()
    `
  })
}
