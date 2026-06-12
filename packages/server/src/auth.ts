import { createHash, randomBytes } from 'node:crypto'
import { createClerkClient, verifyToken } from '@clerk/backend'
import { sql } from './db/index.js'
import { env } from './env.js'
import { claimInvitations, ensurePersonalWorkspace } from './workspaces.js'

// A principal is whoever is behind a request/connection.
// - 'user'    → a real person (Clerk browser session) or CLI token, with our users.id
// - 'service' → the shared COLLAB_TOKEN (sync-check/admin); no user row, full access
export type Principal =
  // features/planName come from the Clerk session JWT (Billing); undefined for
  // non-browser principals (dd_ tokens), which the entitlements layer treats as
  // "plan unknown" → unlimited.
  | { kind: 'user'; userId: string; features?: string[]; planName?: string }
  | { kind: 'service' }

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })

// clerk_id → our users.id, cached to avoid a DB hit per ws message/request.
const userIdCache = new Map<string, string>()

export const API_TOKEN_PREFIX = 'dd_'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Mint a new CLI/API token for a user. Returns the plaintext ONCE; only the hash is stored. */
export async function issueApiToken(userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = API_TOKEN_PREFIX + randomBytes(24).toString('base64url')
  const [row] = await sql<{ id: string }[]>`
    insert into api_tokens (user_id, token_hash, name)
    values (${userId}, ${hashToken(token)}, ${name})
    returning id
  `
  return { id: row!.id, token }
}

async function userFromClerk(clerkId: string): Promise<string> {
  const cached = userIdCache.get(clerkId)
  if (cached) return cached

  const [existing] = await sql<{ id: string }[]>`select id from users where clerk_id = ${clerkId}`
  if (existing) {
    userIdCache.set(clerkId, existing.id)
    // First auth this process: make sure their personal workspace + any pending
    // invitations are resolved (cheap; runs once per user per process).
    await ensurePersonalWorkspace(existing.id)
    await claimInvitations(existing.id)
    return existing.id
  }

  // First login: pull email/name from Clerk to populate our row.
  const u = await clerk.users.getUser(clerkId)
  const email =
    u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? `${clerkId}@clerk.local`
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || null
  const [created] = await sql<{ id: string }[]>`
    insert into users (clerk_id, email, name)
    values (${clerkId}, ${email}, ${name})
    on conflict (clerk_id) do update set email = excluded.email
    returning id
  `
  userIdCache.set(clerkId, created!.id)
  await ensurePersonalWorkspace(created!.id)
  await claimInvitations(created!.id)
  return created!.id
}

async function userFromApiToken(token: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string }[]>`
    update api_tokens set last_used_at = now()
    where token_hash = ${hashToken(token)}
    returning user_id
  `
  return row?.user_id ?? null
}

/**
 * Resolve a bearer token (HTTP) or ws connection token to a principal.
 * Order: service token, then our CLI/API token, then a Clerk session JWT.
 */
export async function authenticate(token: string | undefined | null): Promise<Principal | null> {
  if (!token) return null
  if (token === env.COLLAB_TOKEN) return { kind: 'service' }

  if (token.startsWith(API_TOKEN_PREFIX)) {
    const userId = await userFromApiToken(token)
    return userId ? { kind: 'user', userId } : null
  }

  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY })
    if (!claims.sub) return null
    // Clerk Billing puts the active plan ('pla') + granted features ('fea') in the
    // session token; strip any scope prefix (e.g. "u:team_workspaces").
    const c = claims as Record<string, unknown>
    const features =
      typeof c.fea === 'string'
        ? c.fea
            .split(',')
            .map((s) => s.trim().split(':').pop() ?? '')
            .filter(Boolean)
        : []
    const planName = typeof c.pla === 'string' ? (c.pla.split(':').pop() ?? undefined) : undefined
    return { kind: 'user', userId: await userFromClerk(claims.sub), features, planName }
  } catch {
    return null
  }
}
