import { randomBytes } from 'node:crypto'
import { issueApiToken } from './auth.js'
import { sql } from './db/index.js'

const EXPIRY_MINUTES = 10

// Human-friendly code like "WXYZ-1234" (no ambiguous chars).
function genUserCode(): string {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = (n: number) =>
    Array.from(randomBytes(n))
      .map((b) => alpha[b % alpha.length])
      .join('')
  return `${pick(4)}-${pick(4)}`
}

export async function startCliAuth(): Promise<{ deviceCode: string; userCode: string; expiresInSec: number }> {
  const deviceCode = randomBytes(32).toString('base64url')
  const userCode = genUserCode()
  await sql`
    insert into cli_auth_requests (device_code, user_code, expires_at)
    values (${deviceCode}, ${userCode}, now() + interval '${sql.unsafe(String(EXPIRY_MINUTES))} minutes')
  `
  return { deviceCode, userCode, expiresInSec: EXPIRY_MINUTES * 60 }
}

/** Browser approval: bind the user code to the signed-in user and mint a token. */
export async function approveCliAuth(userCode: string, userId: string): Promise<boolean> {
  const [req] = await sql<{ id: string }[]>`
    select id from cli_auth_requests
    where upper(user_code) = upper(${userCode}) and approved_by is null and expires_at > now()
  `
  if (!req) return false
  const { token } = await issueApiToken(userId, 'mdocs CLI')
  await sql`update cli_auth_requests set approved_by = ${userId}, token = ${token} where id = ${req.id}`
  return true
}

/** CLI poll: returns the token once approved (and clears it), else pending/expired. */
export async function pollCliAuth(
  deviceCode: string,
): Promise<{ status: 'pending' | 'approved' | 'expired'; token?: string }> {
  const [req] = await sql<{ id: string; token: string | null; expired: boolean }[]>`
    select id, token, (expires_at <= now()) as expired
    from cli_auth_requests where device_code = ${deviceCode}
  `
  if (!req || req.expired) return { status: 'expired' }
  if (!req.token) return { status: 'pending' }
  await sql`delete from cli_auth_requests where id = ${req.id}` // one-time delivery
  return { status: 'approved', token: req.token }
}
