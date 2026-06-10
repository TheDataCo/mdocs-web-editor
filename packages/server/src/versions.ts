import { createHash } from 'node:crypto'
import { DOC_TEXT_FIELD } from '@mdocs/core'
import type { Principal } from './auth.js'
import { sql } from './db/index.js'
import { loadDocState } from './persistence.js'

export interface Version {
  id: string
  n: number
  contentHash: string
  source: string
  message: string | null
  authorId: string | null
  createdAt: string
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Current head markdown text of a doc (reconstructed from the Yjs state). */
export async function headText(docId: string): Promise<string> {
  const ydoc = await loadDocState(docId)
  const text = ydoc.getText(DOC_TEXT_FIELD).toString()
  ydoc.destroy()
  return text
}

async function latestVersion(docId: string): Promise<Version | undefined> {
  const [row] = await sql<Version[]>`
    select id, n, content_hash as "contentHash", source, message, author_id as "authorId", created_at as "createdAt"
    from doc_versions where doc_id = ${docId} and status = 'active'
    order by n desc limit 1
  `
  return row
}

export async function getVersionContent(docId: string, n: number): Promise<string | undefined> {
  const [row] = await sql<{ content: string }[]>`
    select content from doc_versions where doc_id = ${docId} and n = ${n}
  `
  return row?.content
}

/**
 * Ensure head is captured as a version, returning it. Creates a new version only
 * if head has drifted from the latest recorded version (a checkpoint of real
 * change, not every read) — this is the merge base for a later push.
 */
export async function checkpointHead(
  docId: string,
  principal: Principal,
  source: string,
): Promise<{ content: string; version: Version }> {
  const content = await headText(docId)
  const hash = hashContent(content)
  const authorId = principal.kind === 'user' ? principal.userId : null

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${docId}::text, 1))`
    const [latest] = await tx<Version[]>`
      select id, n, content_hash as "contentHash", source, message, author_id as "authorId", created_at as "createdAt"
      from doc_versions where doc_id = ${docId} and status = 'active' order by n desc limit 1
    `
    if (latest && latest.contentHash === hash) return { content, version: latest }
    const nextN = (latest?.n ?? 0) + 1
    const [created] = await tx<Version[]>`
      insert into doc_versions (doc_id, n, content, content_hash, author_id, source, status)
      values (${docId}, ${nextN}, ${content}, ${hash}, ${authorId}, ${source}, 'active')
      returning id, n, content_hash as "contentHash", source, message, author_id as "authorId", created_at as "createdAt"
    `
    return { content, version: created! }
  })
}

export async function listVersions(docId: string): Promise<Version[]> {
  return sql<Version[]>`
    select id, n, content_hash as "contentHash", source, message, author_id as "authorId", created_at as "createdAt"
    from doc_versions where doc_id = ${docId} and status = 'active' order by n desc
  `
}

export { latestVersion }
