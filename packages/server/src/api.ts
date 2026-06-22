import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hocuspocus } from '@hocuspocus/server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { DOC_TEXT_FIELD } from '@mdocs/core'
import { API_TOKEN_PREFIX, authenticate, issueApiToken, type Principal } from './auth.js'
import { userPlanSlug } from './billing.js'
import { approveCliAuth, pollCliAuth, startCliAuth } from './cli-auth.js'
import { addCommentToDoc, listComments, newComment, setCommentStatus } from './comments.js'
import { clerkEntitlements, getEntitlements, serializeEntitlements } from './entitlements.js'
import { env } from './env.js'
import { convertToMarkdown, LlmError } from './llm.js'
import { callsThisMonth, logRequest, recentActivity } from './usage.js'
import { applyTextEdits, threeWayMerge } from './merge.js'
import { loadDocState } from './persistence.js'
import { checkpointHead, createVersion, getVersionContent, listVersions } from './versions.js'
import { sql } from './db/index.js'
import {
  canAccess,
  canEdit,
  countDocCollaborators,
  createDoc,
  createLink,
  docOwnerId,
  favoriteDocIds,
  getDoc,
  hasDocShare,
  isTrashedDocVisible,
  listDocs,
  listFavoriteDocs,
  listRecentDocs,
  listSharedDocs,
  listTrashedDocs,
  moveDoc,
  pinnedDocIds,
  recordOpen,
  redeemLink,
  renameDoc,
  restoreDoc,
  setFavorite,
  setPin,
  shareLinkRole,
  softDeleteDoc,
} from './docs.js'
import {
  countWorkspaceSeats,
  createTeamWorkspace,
  ensurePersonalWorkspace,
  hasWorkspaceSeat,
  inviteToWorkspace,
  isMember,
  listMembers,
  listTrashedWorkspaces,
  listWorkspaces,
  memberRole,
  renameWorkspace,
  restoreWorkspace,
  softDeleteWorkspace,
  workspaceOwnerId,
  workspaceType,
} from './workspaces.js'

// The web build, when present (prod), is served from this same origin so the
// SPA, API, and websocket share a host — no CORS, URLs derived from location.
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

type Vars = { principal: Principal }

export function createApi(hocuspocus: Hocuspocus) {
  const app = new Hono<{ Variables: Vars }>()

  // Request logging to stdout (Railway/Docker capture this). Skip the frequent
  // health check so it doesn't drown out real traffic.
  const log = logger()
  app.use('*', (c, next) => (c.req.path === '/healthz' ? next() : log(c, next)))

  // Surface unhandled errors. Hono otherwise turns a thrown error into a bare
  // 500 with nothing logged, so real failures would be invisible in Railway.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error(`unhandled error on ${c.req.method} ${c.req.path}:`, err)
    return c.json({ error: { code: 'server_error', message: 'internal error' } }, 500)
  })

  app.use('/api/*', cors())
  app.get('/healthz', (c) => c.json({ ok: true }))

  // Authenticate every /api request to a principal (Clerk JWT, dd_ token, or service token).
  app.use('/api/*', async (c, next) => {
    // CLI device-auth start/poll are public — the device code is the secret.
    if (c.req.path === '/api/cli/auth/start' || c.req.path === '/api/cli/auth/poll') return next()
    // Public read-via-share-link: the link token in the query is the secret, so
    // logged-out visitors can view (read-only) and be nudged to sign in to edit.
    if (c.req.path.startsWith('/api/share/')) return next()
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

  // Per-doc collaborator cap, governed by the doc OWNER's plan (hosted only).
  // Returns the limit if adding `candidate` would exceed it, else null (allowed).
  async function collabCapReached(docId: string, candidate: string): Promise<number | null> {
    if (env.BILLING !== 'clerk') return null
    const owner = await docOwnerId(docId)
    if (!owner) return null
    const slug = await userPlanSlug(owner)
    const limit = (await clerkEntitlements({ kind: 'user', userId: owner, planName: slug })).maxCollaboratorsPerDoc
    if (!Number.isFinite(limit) || (await hasDocShare(docId, candidate))) return null
    return (await countDocCollaborators(docId)) >= limit ? limit : null
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
    const [ws] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_members m
      join workspaces w on w.id = m.workspace_id and w.deleted_at is null
      where m.user_id = ${userId}
    `
    return c.json({
      planName: ent.planName,
      entitlements: serializeEntitlements(ent),
      usage: { docs: docs?.n ?? 0, workspaces: ws?.n ?? 0, apiCalls: await callsThisMonth(userId) },
    })
  })

  // Recent CLI/agent API requests for this user (the activity log).
  app.get('/api/me/activity', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ activity: [] })
    return c.json({ activity: await recentActivity(userId, 100) })
  })

  // AI: convert raw text (logs, JSON, HTML, …) into clean markdown via OpenRouter.
  // Stateless — not tied to a doc; the CLI writes the result to a local file.
  app.post('/api/convert', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in to use AI conversion' } }, 403)
    const body = await c.req.json().catch(() => ({}))
    const text = typeof body.text === 'string' ? body.text : ''
    const hint = typeof body.hint === 'string' && body.hint.trim() ? body.hint.trim() : undefined
    if (!text.trim()) return c.json({ error: { code: 'invalid', message: 'text is required' } }, 400)
    try {
      return c.json({ markdown: await convertToMarkdown(text, hint) })
    } catch (e) {
      if (e instanceof LlmError) {
        return c.json({ error: { code: e.code, message: e.message } }, e.code === 'ai_unavailable' ? 503 : 502)
      }
      throw e
    }
  })

  // Public read of a doc via a share-link token (no auth). Returns the title +
  // current markdown for a read-only render; the SPA shows Copy + an Edit
  // button that sends the visitor to sign in (editing always requires an account).
  app.get('/api/share/:id', async (c) => {
    const id = c.req.param('id')
    const role = await shareLinkRole(id, c.req.query('token') ?? '')
    if (!role) return c.json({ error: { code: 'not_found', message: 'invalid or expired link' } }, 404)
    const doc = await getDoc(id)
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    const ydoc = await loadDocState(id)
    const text = ydoc.getText(DOC_TEXT_FIELD).toString()
    ydoc.destroy()
    return c.json({ doc: { id: doc.id, title: doc.title }, content: text, role })
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
    // Comments posted with a dd_ token are signed as the owner's agent —
    // "<name> (email's agent)" when the CLI passes --as, else "email's agent".
    // The suffix is applied server-side so an agent can't impersonate a person.
    let authorName: string | null = null
    if (principal.kind === 'user' && c.req.header('Authorization')?.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) {
      const [u] = await sql<{ email: string }[]>`select email from users where id = ${principal.userId}`
      const who = u?.email ?? 'unknown'
      const signed = typeof body.author === 'string' && body.author.trim() ? body.author.trim().slice(0, 60) : null
      authorName = signed ? `${signed} (${who}'s agent)` : `${who}'s agent`
    }
    const comment = newComment(
      principal,
      text,
      typeof body.excerpt === 'string' ? body.excerpt : '',
      body.parentId ?? null,
      authorName,
    )
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

  // Deleting a workspace soft-deletes it and its docs (recoverable server-side).
  // Owners only; the personal workspace can't be deleted.
  app.delete('/api/workspaces/:id', async (c) => {
    const userId = requireUser(c)
    const wsId = c.req.param('id')
    const role = await (userId ? memberRole(userId, wsId) : null)
    if (!userId || role !== 'owner') {
      return c.json({ error: { code: 'permission_denied', message: 'owners only' } }, 403)
    }
    const type = await workspaceType(wsId)
    if (!type) return c.json({ error: { code: 'not_found', message: 'no such workspace' } }, 404)
    if (type === 'personal') {
      return c.json({ error: { code: 'invalid', message: 'the personal workspace cannot be deleted' } }, 400)
    }
    await softDeleteWorkspace(wsId)
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
    // Per-workspace member cap, governed by the workspace OWNER's plan (hosted
    // only). Re-inviting an existing member/invitee (role change) is exempt.
    if (env.BILLING === 'clerk' && !(await hasWorkspaceSeat(wsId, email))) {
      const owner = await workspaceOwnerId(wsId)
      const slug = owner ? await userPlanSlug(owner) : undefined
      const limit = (await clerkEntitlements({ kind: 'user', userId: owner ?? userId, planName: slug }))
        .maxMembersPerWorkspace
      if (Number.isFinite(limit) && (await countWorkspaceSeats(wsId)) >= limit) {
        return c.json(
          { error: { code: 'plan_limit', message: `This workspace is at its ${limit}-member limit.` } },
          402,
        )
      }
    }
    const inviteRole = body.role === 'admin' ? 'admin' : 'member'
    return c.json({ result: await inviteToWorkspace(wsId, email, inviteRole, userId) }, 201)
  })

  // The caller's trash retention window. Browser JWTs carry the plan; dd_
  // tokens don't, so resolve the plan from the subscription store (same as
  // API-call metering does).
  async function trashDays(c: { get: (k: 'principal') => Principal }): Promise<number> {
    const p = c.get('principal')
    if (p.kind === 'user' && p.planName === undefined && env.BILLING === 'clerk') {
      const slug = await userPlanSlug(p.userId)
      return (await clerkEntitlements({ kind: 'user', userId: p.userId, planName: slug })).trashRetentionDays
    }
    return (await getEntitlements(p)).trashRetentionDays
  }

  // Recently deleted: docs + workspaces inside the caller's plan retention
  // window (Free 15 days, Individual 90; self-host 90). Soft-deleted rows are
  // kept beyond the window — the window only gates visibility/restore.
  app.get('/api/trash', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ docs: [], workspaces: [], retentionDays: 0 })
    const days = await trashDays(c)
    const [docs, workspaces] = await Promise.all([
      listTrashedDocs(userId, days),
      listTrashedWorkspaces(userId, days),
    ])
    return c.json({ docs, workspaces, retentionDays: days })
  })

  // Read a trashed doc's markdown (CLI `mdocs trash view`).
  app.get('/api/trash/docs/:id/content', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const id = c.req.param('id')
    if (!(await isTrashedDocVisible(id, userId, await trashDays(c)))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc in trash' } }, 404)
    }
    const ydoc = await loadDocState(id)
    const text = ydoc.getText(DOC_TEXT_FIELD).toString()
    ydoc.destroy()
    return c.text(text)
  })

  app.post('/api/docs/:id/restore', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    const ok = await restoreDoc(c.req.param('id'), userId, await trashDays(c))
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'not restorable' } }, 404)
  })

  app.post('/api/workspaces/:id/restore', async (c) => {
    const userId = requireUser(c)
    const wsId = c.req.param('id')
    const role = await (userId ? memberRole(userId, wsId) : null)
    if (!userId || role !== 'owner') {
      return c.json({ error: { code: 'permission_denied', message: 'owners only' } }, 403)
    }
    const ok = await restoreWorkspace(wsId, await trashDays(c))
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'not restorable' } }, 404)
  })

  // Tag each doc with whether the calling user has starred / pinned it (so the
  // star + pin render correctly in any listing). No-op for the service principal.
  async function withFlags<T extends { id: string }>(
    principal: Principal,
    docs: T[],
  ): Promise<(T & { favorite: boolean; pinned: boolean })[]> {
    if (principal.kind !== 'user' || docs.length === 0) {
      return docs.map((d) => ({ ...d, favorite: false, pinned: false }))
    }
    const [fav, pins] = await Promise.all([
      favoriteDocIds(principal.userId),
      pinnedDocIds(principal.userId),
    ])
    return docs.map((d) => ({ ...d, favorite: fav.has(d.id), pinned: pins.has(d.id) }))
  }

  // Docs
  app.get('/api/docs', async (c) => {
    const ws = c.req.query('workspace') || undefined
    const principal = c.get('principal')
    return c.json({ docs: await withFlags(principal, await listDocs(principal, ws)) })
  })

  // The "Shared" view: docs shared with you + docs you've shared out (with owner).
  app.get('/api/docs/shared', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ docs: [] })
    return c.json({ docs: await withFlags(c.get('principal'), await listSharedDocs(userId)) })
  })

  // The "Favorites" view: docs this user has starred (and can still access).
  app.get('/api/docs/favorites', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ docs: [] })
    return c.json({ docs: await withFlags(c.get('principal'), await listFavoriteDocs(userId)) })
  })

  // The "Recent" view: docs this user has recently opened (and can still access).
  app.get('/api/docs/recent', async (c) => {
    const userId = requireUser(c)
    if (!userId) return c.json({ docs: [] })
    return c.json({ docs: await withFlags(c.get('principal'), await listRecentDocs(userId)) })
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
    const principal = c.get('principal')
    let favorite = false
    let pinned = false
    if (principal.kind === 'user') {
      const [fav, pins] = await Promise.all([favoriteDocIds(principal.userId), pinnedDocIds(principal.userId)])
      favorite = fav.has(doc.id)
      pinned = pins.has(doc.id)
      // Record the open for the Recent view (best-effort; never blocks the read).
      recordOpen(principal.userId, doc.id).catch(() => {})
    }
    return c.json({ doc, canEdit: await canEdit(principal, doc.id), favorite, pinned })
  })

  // Star / unstar a doc for the calling user (needs view access).
  app.put('/api/docs/:id/favorite', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    await setFavorite(userId, id, true)
    return c.json({ ok: true, favorite: true })
  })

  app.delete('/api/docs/:id/favorite', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    await setFavorite(userId, id, false)
    return c.json({ ok: true, favorite: false })
  })

  // Pin / unpin a doc for the calling user (needs view access).
  app.put('/api/docs/:id/pin', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    if (!(await canAccess(c.get('principal'), id))) {
      return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    }
    await setPin(userId, id, true)
    return c.json({ ok: true, pinned: true })
  })

  app.delete('/api/docs/:id/pin', async (c) => {
    const id = c.req.param('id')
    const userId = requireUser(c)
    if (!userId) return c.json({ error: { code: 'permission_denied', message: 'sign in' } }, 403)
    await setPin(userId, id, false)
    return c.json({ ok: true, pinned: false })
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
    const cap = await collabCapReached(id, userId)
    if (cap !== null) {
      return c.json({ error: { code: 'plan_limit', message: `This document is at its ${cap}-collaborator limit.` } }, 402)
    }
    const body = await c.req.json().catch(() => ({}))
    const ok = await redeemLink(id, typeof body.token === 'string' ? body.token : '', userId)
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'not_found', message: 'invalid link' } }, 404)
  })

  app.patch('/api/docs/:id', async (c) => {
    const id = c.req.param('id')
    const principal = c.get('principal')
    // Rename/move are writes — viewer shares grant read access only.
    if (!(await canEdit(principal, id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    let doc: Awaited<ReturnType<typeof renameDoc>>
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
    if (!(await canEdit(c.get('principal'), id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    await softDeleteDoc(id)
    return c.json({ ok: true })
  })

  // Share a single doc with a specific person (grants access outside its workspace).
  app.post('/api/docs/:id/share', async (c) => {
    const id = c.req.param('id')
    // Sharing grants access, so it needs edit rights — otherwise a viewer
    // could re-share, or upsert their own row from viewer to editor.
    if (!(await canEdit(c.get('principal'), id))) {
      return c.json({ error: { code: 'permission_denied', message: 'no access' } }, 403)
    }
    const body = await c.req.json().catch(() => ({}))
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!email) return c.json({ error: { code: 'invalid', message: 'email required' } }, 400)
    const role = body.role === 'viewer' ? 'viewer' : 'editor'
    const [user] = await sql<{ id: string }[]>`select id from users where lower(email) = lower(${email})`
    if (!user) return c.json({ result: { status: 'no_account' } })
    const cap = await collabCapReached(id, user.id)
    if (cap !== null) {
      return c.json({ error: { code: 'plan_limit', message: `Your plan allows ${cap} collaborators per document — upgrade for more.` } }, 402)
    }
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
