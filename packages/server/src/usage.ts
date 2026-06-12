import { sql } from './db/index.js'

// CLI/agent API-call metering + activity. Only dd_-token requests are logged.

export async function logRequest(userId: string, method: string, path: string, status: number): Promise<void> {
  await sql`
    insert into api_requests (user_id, method, path, status)
    values (${userId}, ${method}, ${path}, ${status})
  `.catch(() => {}) // never let logging break a request
}

/** API calls this calendar month (the metered unit). */
export async function callsThisMonth(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from api_requests
    where user_id = ${userId} and created_at >= date_trunc('month', now())
  `
  return row?.n ?? 0
}

export async function recentActivity(userId: string, limit = 100) {
  return sql<{ method: string; path: string; status: number; created_at: string }[]>`
    select method, path, status, created_at from api_requests
    where user_id = ${userId} order by created_at desc limit ${limit}
  `
}
