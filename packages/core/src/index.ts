// @mdocs/core — types and logic shared by server, web, and cli.
// The diff→rebase→Yjs-ops pipeline (milestone 4) lives here so cli and web
// use the exact same merge semantics.

/** Name of the Y.Text field holding the markdown body inside each Y.Doc. */
export const DOC_TEXT_FIELD = 'content'

/** Name of the Y.Map holding comments (keyed by comment id) inside each Y.Doc. */
export const DOC_COMMENTS_FIELD = 'comments'

/** The shape stored as each value in the comments Y.Map (and mirrored to Postgres). */
export interface CommentValue {
  id: string
  authorId: string | null
  authorName: string | null
  body: string
  // Encoded Yjs RelativePositions (base64); null for a document-level comment.
  anchorStart: string | null
  anchorEnd: string | null
  excerpt: string
  parentId: string | null
  status: 'open' | 'resolved'
  resolvedBy: string | null
  createdAt: number
  resolvedAt: number | null
}

export interface DocMeta {
  id: string
  title: string
  workspaceId: string | null
  createdAt: string
  updatedAt: string
}

/** Stable machine-readable error codes (CLI --json contract). */
export type ErrorCode =
  | 'auth_failed'
  | 'not_found'
  | 'permission_denied'
  | 'stale_manifest'
  | 'patch_conflict'
  | 'network'
  | 'server_error'
