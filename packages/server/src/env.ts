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

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  CLERK_SECRET_KEY: required('CLERK_SECRET_KEY'),
  // Server-only service credential (sync-check / admin). NEVER shipped to browsers.
  COLLAB_TOKEN: process.env.COLLAB_TOKEN ?? 'dev-token',
  PORT: Number(process.env.PORT ?? 3001),
}
