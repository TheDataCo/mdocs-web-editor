import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authenticate, issueApiToken, type Principal } from './auth.js'
import { sql } from './db/index.js'
import { createDoc, getDoc, listDocs } from './docs.js'
import {
  createTeamWorkspace,
  ensurePersonalWorkspace,
  inviteToWorkspace,
  isMember,
  listMembers,
  listWorkspaces,
  memberRole,
} from './workspaces.js'

// The web build, when present (prod), is served from this same origin so the
// SPA, API, and websocket share a host — no CORS, URLs derived from location.
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

type Vars = { principal: Principal }

export function createApi() {
  const app = new Hono<{ Variables: Vars }>()

  app.use('/api/*', cors())
  app.get('/healthz', (c) => c.json({ ok: true }))

  // Authenticate every /api request to a principal (Clerk JWT, dd_ token, or service token).
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const principal = await authenticate(token)
    if (!principal) {
      return c.json({ error: { code: 'auth_failed', message: 'invalid or missing token' } }, 401)
    }
    c.set('principal', principal)
    await next()
  })

  function requireUser(c: { get: (k: 'principal') => Principal }): string | null {
    const p = c.get('principal')
    return p.kind === 'user' ? p.userId : null
  }

  // Workspaces
  app.get('/api/workspaces', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ workspaces: [] })
    await ensurePersonalWorkspace(userId)
    return c.json({ workspaces: await listWorkspaces(userId) })
  })

  app.post('/api/workspaces', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Team'
    return c.json({ workspace: await createTeamWorkspace(userId, name) }, 201)
  })

  app.get('/api/workspaces/:id/members', async (c) => {
    const userId = requireUser(c)
    if (!userId || !(await isMember(userId, c.req.param('id')))) {
      return c.json({ error: { code: 'permission_denied', message: 'not a member' } }, 403)
    }
    return c.json({ members: await listMembers(c.req.param('id')) })
  })

  app.post('/api/workspaces/:id/invitations', async (c) => {
    const userId = requireUser(c)
    const wsId = c.req.param('id')
    const role = await (userId ? memberRole(userId, wsId) : null)
    if (!userId || (role !== 'owner' && role !== 'admin')) {
      return c.json({ error: { code: 'permission_denied', message: 'admins only' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!email) return c.json({ error: { code: 'invalid', message: 'email required' } }, 400)
    const inviteRole = body.role === 'admin' ? 'admin' : 'member'
    return c.json({ result: await inviteToWorkspace(wsId, email, inviteRole, userId) }, 201)
  })

  // Docs
  app.get('/api/docs', async (c) => {
    const ws = c.req.query('workspace') || undefined
    return c.json({ docs: await listDocs(c.get('principal'), ws) })
  })

  app.post('/api/docs', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in to create docs' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled'
    // Default to the user's personal workspace; otherwise require membership.
    const workspaceId =
      typeof body.workspaceId === 'string' && body.workspaceId
        ? body.workspaceId
        : await ensurePersonalWorkspace(userId)
    if (!(await isMember(userId, workspaceId))) {
      return c.json({ error: { code: 'permission_denied', message: 'not a workspace member' } }, 403)
    }
    return c.json({ doc: await createDoc(title, workspaceId, userId) }, 201)
  })

  app.get('/api/docs/:id', async (c) => {
    const doc = await getDoc(c.req.param('id'))
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    return c.json({ doc })
  })

  // CLI / API tokens (the "generate a token in the app" flow). Plaintext shown once.
  app.post('/api/tokens', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'CLI token'
    return c.json({ token: await issueApiToken(userId, name) }, 201)
  })

  app.get('/api/tokens', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const tokens = await sql<{ id: string; name: string; last_used_at: string | null; created_at: string }[]>`
      select id, name, last_used_at, created_at from api_tokens
      where user_id = ${userId} order by created_at desc
    `
    return c.json({ tokens })
  })

  app.delete('/api/tokens/:id', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    await sql`delete from api_tokens where id = ${c.req.param('id')} and user_id = ${userId}`
    return c.json({ ok: true })
  })

  if (existsSync(WEB_DIST)) {
    app.use('/*', serveStatic({ root: WEB_DIST }))
    app.get('/*', serveStatic({ root: WEB_DIST, path: 'index.html' }))
  } else {
    app.get('/', (c) => c.text('mdocs sync server (no web build)'))
  }

  return app
}
