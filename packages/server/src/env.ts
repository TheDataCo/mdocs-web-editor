import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'

// Load the nearest .env walking up from cwd (root .env in the monorepo).
let dir = process.cwd()
for (;;) {
  const candidate = resolve(dir, '.env')
  if (existsSync(candidate)) {
    config({ path: candidate })
    break
  }
  const parent = resolve(dir, '..')
  if (parent === dir) break
  dir = parent
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

// The service token bypasses all per-doc authorization, so a weak or example
// value is equivalent to no auth at all. Unset disables service auth entirely.
function serviceToken(): string | undefined {
  const value = process.env.COLLAB_TOKEN
  if (value === undefined || value === '') return undefined
  if (value === 'dev-token' || value.length < 16) {
    throw new Error(
      'COLLAB_TOKEN must be a strong secret (16+ chars, not the example value). Generate one with: openssl rand -hex 32',
    )
  }
  return value
}

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  CLERK_SECRET_KEY: required('CLERK_SECRET_KEY'),
  // Server-only service credential (sync-check / admin). NEVER shipped to browsers.
  COLLAB_TOKEN: serviceToken(),
  // 'clerk' enables Clerk Billing plan enforcement; unset (self-host) = unlimited.
  BILLING: process.env.BILLING,
  PORT: Number(process.env.PORT ?? 3001),
}
