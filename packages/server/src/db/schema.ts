import {
  bigint,
  customType,
  index,
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

export const docs = pgTable('docs', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  // Nullable until auth lands (milestone 3); docs created before then are unowned.
  ownerId: uuid('owner_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

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

export const linkShares = pgTable('link_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  docId: uuid('doc_id')
    .notNull()
    .references(() => docs.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
