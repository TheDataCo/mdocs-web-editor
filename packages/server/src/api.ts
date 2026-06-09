import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authenticate, issueApiToken, type Principal } from './auth.js'
import { sql } from './db/index.js'
import {
  canAccess,
  canEdit,
  createDoc,
  createLink,
  getDoc,
  listDocs,
  moveDoc,
  redeemLink,
  renameDoc,
  softDeleteDoc,
} from './docs.js'
import {
  createTeamWorkspace,
  ensurePersonalWorkspace,
  inviteToWorkspace,
  isMember,
  listMembers,
  listWorkspaces,
  memberRole,
  renameWorkspace,
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

  app.patch('/api/workspaces/:id', async (c) => {
    const userId = requireUser(c)
    const wsId = c.req.param('id')
    const role = await (userId ? memberRole(userId, wsId) : null)
    if (!userId || (role !== 'owner' && role !== 'admin')) {
      return c.json({ error: { code: 'permission_denied', message: 'admins only' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: { code: 'invalid', message: 'name required' } }, 400)
    await renameWorkspace(wsId, name)
    return c.json({ ok: true })
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
    const id = c.req.param('id')
    // Don't reveal existence/metadata to users without access.
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    const doc = await getDoc(id)
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    return c.json({ doc, canEdit: await canEdit(c.get('principal'), doc.id) })
  })

  // Share links (read-only or editor). Creating one requires edit access.
  app.post('/api/docs/:id/links', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId || !(await canEdit(c.get('principal'), id))) {
      return c.json({ error: { code: 'permission_denied', message: 'need edit access to share' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const role = body.role === 'viewer' ? 'viewer' : 'editor'
    return c.json({ token: await createLink(id, role, userId), role }, 201)
  })

  app.post('/api/docs/:id/links/redeem', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const ok = await redeemLink(id, typeof body.token === 'string' ? body.token : '', userId)
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'invalid link' } }, 404)
  })

  app.patch('/api/docs/:id', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canAccess(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    let doc
    if (typeof body.title === 'string' && body.title.trim()) {
      doc = await renameDoc(id, body.title.trim())
    }
    // Move between workspaces (drag-and-drop): require membership of the target.
    if (typeof body.workspaceId === 'string' && body.workspaceId) {
      const userId = principal.kind === 'user' ? principal.userId : null
      if (userId && !(await isMember(userId, body.workspaceId))) {
        return c.json({ error: { code: 'permission_denied', message: 'not a member of target' } }, 403)
      }
      doc = await moveDoc(id, body.workspaceId)
    }
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    return c.json({ doc })
  })

  app.delete('/api/docs/:id', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    await softDeleteDoc(id)
    return c.json({ ok: true })
  })

  // Share a single doc with a specific person (grants access outside its workspace).
  app.post('/api/docs/:id/share', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!email) return c.json({ error: { code: 'invalid', message: 'email required' } }, 400)
    const [user] = await sql<{ id: string }[]>`select id from users where lower(email) = lower(${email})`
    if (!user) return c.json({ result: { status: 'no_account' } })
    await sql`
      insert into doc_access (doc_id, user_id, role) values (${id}, ${user.id}, 'editor')
      on conflict (doc_id, user_id) do nothing
    `
    return c.json({ result: { status: 'shared' } })
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
