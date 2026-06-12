import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hocuspocus } from '@hocuspocus/server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DOC_TEXT_FIELD } from '@mdocs/core'
import { API_TOKEN_PREFIX, authenticate, issueApiToken, type Principal } from './auth.js'
import { userPlanSlug } from './billing.js'
import { approveCliAuth, pollCliAuth, startCliAuth } from './cli-auth.js'
import { addCommentToDoc, listComments, newComment, setCommentStatus } from './comments.js'
import { clerkEntitlements, getEntitlements, serializeEntitlements } from './entitlements.js'
import { env } from './env.js'
import { callsThisMonth, logRequest, recentActivity } from './usage.js'
import { applyTextEdits, threeWayMerge } from './merge.js'
import { loadDocState } from './persistence.js'
import { checkpointHead, createVersion, getVersionContent, listVersions } from './versions.js'
import { sql } from './db/index.js'
import {
  canAccess,
  canEdit,
  createDoc,
  createLink,
  getDoc,
  listDocs,
  listSharedDocs,
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

export function createApi(hocuspocus: Hocuspocus) {
  const app = new Hono<{ Variables: Vars }>()

  app.use('/api/*', cors())
  app.get('/healthz', (c) => c.json({ ok: true }))

  // Authenticate every /api request to a principal (Clerk JWT, dd_ token, or service token).
  app.use('/api/*', async (c, next) => {
    // CLI device-auth start/poll are public — the device code is the secret.
    if (c.req.path === '/api/cli/auth/start' || c.req.path === '/api/cli/auth/poll') return next()
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const principal = await authenticate(token)
    if (!principal) {
      return c.json({ error: { code: 'auth_failed', message: 'invalid or missing token' } }, 401)
    }
    c.set('principal', principal)

    // CLI/agent (dd_ token) requests are the metered "API calls" — only on the
    // hosted instance (BILLING=clerk); self-host neither meters nor logs. Identity/
    // account reads (/api/me*) are free — whoami, plan, and auth shouldn't cost.
    const isCli = principal.kind === 'user' && !!token && token.startsWith(API_TOKEN_PREFIX)
    const metered = isCli && env.BILLING === 'clerk' && !c.req.path.startsWith('/api/me')
    if (metered) {
      const userId = (principal as { userId: string }).userId
      const slug = await userPlanSlug(userId)
      const limit = (await clerkEntitlements({ kind: 'user', userId, planName: slug })).apiCallsPerMonth
      if (Number.isFinite(limit) && (await callsThisMonth(userId)) >= limit) {
        return c.json({ error: { code: 'plan_limit', message: 'Monthly API call limit reached — upgrade for more.' } }, 429)
      }
    }
    await next()
    if (metered) {
      void logRequest((principal as { userId: string }).userId, c.req.method, c.req.path, c.res.status)
    }
  })

  function requireUser(c: { get: (k: 'principal') => Principal }): string | null {
    const p = c.get('principal')
    return p.kind === 'user' ? p.userId : null
  }

  // CLI device-authorization flow (`mdocs auth login`)
  app.post('/api/cli/auth/start', async (c) => {
    const { deviceCode, userCode, expiresInSec } = await startCliAuth()
    const host = c.req.header('host') ?? 'mdocs.datacompany.dev'
    const proto = host.startsWith('localhost') ? 'http' : 'https'
    const base = `${proto}://${host}`
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/cli-auth`,
      verification_uri_complete: `${base}/cli-auth?code=${userCode}`,
      interval: 2,
      expires_in: expiresInSec,
    })
  })

  app.post('/api/cli/auth/poll', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await pollCliAuth(typeof body.device_code === 'string' ? body.device_code : '')
    return c.json(result)
  })

  app.post('/api/cli/auth/approve', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const ok = await approveCliAuth(typeof body.user_code === 'string' ? body.user_code : '', userId)
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'invalid or expired code' } }, 404)
  })

  app.get('/api/me', async (c) => {
    const p = c.get('principal')
    if (p.kind !== 'user') return c.json({ user: null })
    const [user] = await sql<{ id: string; email: string; name: string | null }[]>`
      select id, email, name from users where id = ${p.userId}
    `
    return c.json({ user })
  })

  // Current plan + entitlements + usage (so the UI can show "Free · 3/10 docs").
  app.get('/api/me/plan', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ plan: null })
    const ent = await getEntitlements(c.get('principal'))
    const [docs] = await sql<{ n: number }[]>`
      select count(*)::int as n from docs d
      join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = ${userId}
      where d.deleted_at is null
    `
    const [collab] = await sql<{ n: number }[]>`
      select count(distinct a.user_id)::int as n from doc_access a
      join docs d on d.id = a.doc_id
      where d.owner_id = ${userId} and a.user_id <> ${userId}
    `
    return c.json({
      planName: ent.planName,
      entitlements: serializeEntitlements(ent),
      usage: { docs: docs?.n ?? 0, collaborators: collab?.n ?? 0, apiCalls: await callsThisMonth(userId) },
    })
  })

  // Recent CLI/agent API requests for this user (the activity log).
  app.get('/api/me/activity', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ activity: [] })
    return c.json({ activity: await recentActivity(userId, 100) })
  })

  // Current markdown text of a doc (for CLI pull).
  app.get('/api/docs/:id/content', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    const ydoc = await loadDocState(id)
    const text = ydoc.getText(DOC_TEXT_FIELD).toString()
    ydoc.destroy()
    return c.text(text)
  })

  // CLI pull: head markdown + the base version to merge a later push against
  // (checkpoints head as a version only if it drifted from the last one).
  app.get('/api/docs/:id/pull', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canAccess(principal, id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    const doc = await getDoc(id)
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    const { content, version } = await checkpointHead(id, principal, 'cli-pull')
    return c.json({ doc: { id: doc.id, title: doc.title }, content, version })
  })

  app.get('/api/docs/:id/versions', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    return c.json({ versions: await listVersions(id) })
  })

  // Fetch a specific version's markdown (read-only history view).
  app.get('/api/docs/:id/versions/:n', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    const content = await getVersionContent(id, Number(c.req.param('n')))
    if (content === undefined) return c.json({ error: { code: 'not_found', message: 'no such version' } }, 404)
    return c.text(content)
  })

  // Revert: restore a previous version's content as a NEW version (non-destructive;
  // applied to the live doc). "Publish a new version based on a previous one."
  app.post('/api/docs/:id/revert', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canEdit(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no edit access to this doc' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const n = Number(body.version)
    const content = await getVersionContent(id, n)
    if (content === undefined) return c.json({ error: { code: 'not_found', message: 'no such version' } }, 404)
    const conn = await hocuspocus.openDirectConnection(id, { principal })
    try {
      await conn.transact((doc) => {
        const ytext = doc.getText(DOC_TEXT_FIELD)
        applyTextEdits(ytext, ytext.toString(), content)
      })
    } finally {
      await conn.disconnect()
    }
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : `revert to v${n}`
    const version = await createVersion(id, principal, 'cli-revert', content, message)
    return c.json({ ok: true, version })
  })

  // Comments (mirrored from the doc's Yjs Y.Map). List over HTTP; add/resolve
  // write into the live doc so browsers update and the mirror stays in sync.
  app.get('/api/docs/:id/comments', async (c) => {
    const id = c.req.param('id')
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    return c.json({ comments: await listComments(id, c.req.query('status')) })
  })

  app.post('/api/docs/:id/comments', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canAccess(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) return c.json({ error: { code: 'invalid', message: 'body required' } }, 400)
    const comment = newComment(principal, text, typeof body.excerpt === 'string' ? body.excerpt : '', body.parentId ?? null)
    await addCommentToDoc(hocuspocus, id, comment)
    return c.json({ comment }, 201)
  })

  app.post('/api/docs/:id/comments/:cid/resolve', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canAccess(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const ok = await setCommentStatus(hocuspocus, id, c.req.param('cid'), body.reopen ? 'open' : 'resolved', principal)
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'no such comment' } }, 404)
  })

  // CLI push: server-side 3-way merge of the client's working text against head,
  // using the pulled base version as the common ancestor. Applies to the LIVE
  // doc (so browsers update instantly) and records a new version with the message.
  app.post('/api/docs/:id/push', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    if (!(await canEdit(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no edit access to this doc' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const working = typeof body.content === 'string' ? body.content : ''
    const baseN = Number(body.baseVersion) || 0
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null
    const base = (baseN ? await getVersionContent(id, baseN) : '') ?? ''

    let conflict = false
    let merged = ''
    const conn = await hocuspocus.openDirectConnection(id, { principal })
    try {
      await conn.transact((doc) => {
        const ytext = doc.getText(DOC_TEXT_FIELD)
        const theirs = ytext.toString()
        const result = threeWayMerge(base, working, theirs)
        if (!result.clean) {
          conflict = true
          return
        }
        applyTextEdits(ytext, theirs, result.text)
        merged = result.text
      })
    } finally {
      await conn.disconnect()
    }
    if (conflict) {
      return c.json(
        { error: { code: 'patch_conflict', message: 'merge conflict with current head; re-pull and retry' } },
        409,
      )
    }
    const version = await createVersion(id, principal, 'cli-push', merged, message)
    return c.json({ ok: true, version })
  })

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
    // Team workspaces are a paid feature on the hosted plan (no-op on self-host).
    if (!(await getEntitlements(c.get('principal'))).teamWorkspaces) {
      return c.json({ error: { code: 'plan_limit', message: 'Upgrade to create team workspaces' } }, 402)
    }
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

  // The "Shared" view: docs shared with you + docs you've shared out (with owner).
  app.get('/api/docs/shared', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ docs: [] })
    return c.json({ docs: await listSharedDocs(userId) })
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
    const role = body.role === 'viewer' ? 'viewer' : 'editor'
    const [user] = await sql<{ id: string }[]>`select id from users where lower(email) = lower(${email})`
    if (!user) return c.json({ result: { status: 'no_account' } })
    await sql`
      insert into doc_access (doc_id, user_id, role) values (${id}, ${user.id}, ${role})
      on conflict (doc_id, user_id) do update set role = excluded.role
    `
    return c.json({ result: { status: 'shared', role } })
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
