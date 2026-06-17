import {
  bigint,
  customType,
  index,
  uniqueIndex,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return 'bytea'
  },
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  name: text('name'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// A workspace is the home for docs. 'personal' = one per user (single member);
// 'team' = our own multi-member workspace (membership/roles/invites below).
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(), // 'personal' | 'team'
  name: text('name').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(), // 'owner' | 'admin' | 'member'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
)

// Invite by email; claimed on the invitee's next login (no email-send dependency).
export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    email: text('email').notNull(),
    role: text('role').notNull(), // 'admin' | 'member'
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_invitations_email_idx').on(t.email)],
)

export const docs = pgTable(
  'docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    // Home workspace. Nullable only to ease migration of pre-workspace rows; the
    // app always sets it on create.
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    // The doc's creator (column kept as owner_id from the pre-workspace schema).
    ownerId: uuid('owner_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('docs_workspace_idx').on(t.workspaceId)],
)

// Append-only Yjs update log: the sync/audit substrate. Compaction snapshots
// never delete rows here (retention is a separate, explicit policy decision).
export const docUpdates = pgTable(
  'doc_updates',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    // Per-doc monotonic, assigned under a per-doc advisory lock (see persistence.ts).
    seq: bigint('seq', { mode: 'number' }).notNull(),
    update: bytea('update').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    origin: text('origin').notNull(), // 'websocket' | 'http'
    clientId: text('client_id'),
    requestId: text('request_id'), // idempotency key for HTTP pushes
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.docId, t.seq] }),
    index('doc_updates_request_id_idx').on(t.docId, t.requestId),
  ],
)

// Latest compacted snapshot per doc; doc load = snapshot + updates where seq > upto_seq.
export const docSnapshots = pgTable('doc_snapshots', {
  docId: uuid('doc_id')
    .primaryKey()
    .references(() => docs.id),
  snapshot: bytea('snapshot').notNull(),
  stateVector: bytea('state_vector').notNull(),
  uptoSeq: bigint('upto_seq', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const docAccess = pgTable(
  'doc_access',
  {
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(), // 'owner' | 'editor'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.userId] })],
)

// Device-authorization flow for `mdocs auth login`: CLI starts a request, user
// approves it in the browser, CLI polls for the issued token.
export const cliAuthRequests = pgTable('cli_auth_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceCode: text('device_code').notNull().unique(), // secret held by the CLI
  userCode: text('user_code').notNull().unique(), // short code shown to the user
  approvedBy: uuid('approved_by').references(() => users.id),
  token: text('token'), // issued dd_ token, delivered once then cleared
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Point-in-time snapshots of a doc's markdown. Serve double duty: the merge
// base for CLI push (3-way: base→working vs base→head) and the history timeline.
// A version is created at meaningful boundaries (a CLI pull that finds head has
// drifted, a CLI push, later: web editing-session checkpoints).
export const docVersions = pgTable(
  'doc_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    n: bigint('n', { mode: 'number' }).notNull(), // per-doc monotonic version number
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    source: text('source').notNull(), // 'cli-pull' | 'cli-push' | 'web'
    // 'active' = part of the doc's real history; 'proposed' = an agent suggestion
    // awaiting human accept/reject (reserved; direct push uses 'active').
    status: text('status').notNull().default('active'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('doc_versions_doc_n_idx').on(t.docId, t.n)],
)

// Comments live in the doc's Yjs state (a Y.Map keyed by comment id); the server
// mirrors them here so the CLI/agents can list and resolve over HTTP.
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(), // also the Y.Map key
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    authorId: uuid('author_id').references(() => users.id),
    authorName: text('author_name'),
    body: text('body').notNull(),
    // Encoded Yjs RelativePositions (base64) + excerpt fallback for orphaned anchors.
    anchorStart: text('anchor_start'),
    anchorEnd: text('anchor_end'),
    excerpt: text('excerpt'),
    parentId: uuid('parent_id'),
    status: text('status').notNull().default('open'), // 'open' | 'resolved'
    // The doc version current when the comment was made (audit/context only;
    // the comment still anchors live in the doc, not pinned to this version).
    createdAtVersion: bigint('created_at_version', { mode: 'number' }),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('comments_doc_status_idx').on(t.docId, t.status)],
)

// One row per CLI/agent (dd_ token) API request — powers the usage meter
// ("API calls / month") and the activity log. Web/session traffic is NOT logged.
export const apiRequests = pgTable(
  'api_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: bigint('status', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_requests_user_time_idx').on(t.userId, t.createdAt)],
)

// Per-user "favorites" (starred docs). A user may favorite any doc they can
// access; the row is harmless if access is later revoked (listings re-check).
export const docFavorites = pgTable(
  'doc_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.docId] })],
)

// Per-user, per-doc "pins": quick-access docs surfaced at the top of their home
// workspace in the editor tree. Distinct from favorites (which are a global view):
// a pin is scoped to the doc's workspace, like pinning a file inside a folder.
export const docPins = pgTable(
  'doc_pins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.docId] })],
)

// Per-user "recently opened" tracking. One row per (user, doc), upserted with a
// fresh opened_at every time the user opens the doc; powers the Recent view.
export const docOpens = pgTable(
  'doc_opens',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    docId: uuid('doc_id')
      .notNull()
      .references(() => docs.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.docId] }),
    index('doc_opens_user_time_idx').on(t.userId, t.openedAt),
  ],
)

export const linkShares = pgTable('link_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  docId: uuid('doc_id')
    .notNull()
    .references(() => docs.id),
  tokenHash: text('token_hash').notNull().unique(),
  role: text('role').notNull().default('editor'), // 'viewer' | 'editor'
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
