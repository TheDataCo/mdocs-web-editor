import { sql } from './db/index.js'
import { env } from './env.js'

// Resolve a user's Clerk Billing plan slug (for CLI/dd_-token requests, which
// don't carry the plan in a JWT). Cached; fail-open (undefined → treat as
// unlimited so we never wrongly block).
const cache = new Map<string, { slug: string | undefined; at: number }>()
const TTL_MS = 60_000

function extractPlanSlug(sub: unknown): string | undefined {
  // Defensive walk: find the slug on an active subscription item's plan.
  const items = (sub as { items?: unknown[] })?.items ?? (Array.isArray(sub) ? sub : [])
  for (const it of items as { status?: string; plan?: { slug?: string } }[]) {
    if (it?.plan?.slug && (!it.status || it.status === 'active')) return it.plan.slug
  }
  const direct = (sub as { plan?: { slug?: string } })?.plan?.slug
  return direct
}

export async function userPlanSlug(userId: string): Promise<string | undefined> {
  const cached = cache.get(userId)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.slug
  let slug: string | undefined
  try {
    const [u] = await sql<{ clerk_id: string | null }[]>`select clerk_id from users where id = ${userId}`
    if (u?.clerk_id) {
      const r = await fetch(`https://api.clerk.com/v1/users/${u.clerk_id}/billing/subscription`, {
        headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      })
      if (r.ok) slug = extractPlanSlug(await r.json())
    }
  } catch {
    /* fail open */
  }
  cache.set(userId, { slug, at: Date.now() })
  return slug
}
