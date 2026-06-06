// @datadocs/core — types and logic shared by server, web, and cli.
// The diff→rebase→Yjs-ops pipeline (milestone 4) lives here so cli and web
// use the exact same merge semantics.

/** Name of the Y.Text field holding the markdown body inside each Y.Doc. */
export const DOC_TEXT_FIELD = 'content'

export interface DocMeta {
  id: string
  title: string
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
