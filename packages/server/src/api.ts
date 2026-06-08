import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { createDoc, getDoc, listDocs } from './docs.js'

// The web build, when present (prod), is served from this same origin so the
// SPA, API, and websocket share a host — no CORS, URLs derived from location.
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

// Milestone-2 API: doc list/create behind the shared COLLAB_TOKEN.
// Real per-user auth + access control replace this in milestone 3.
export function createApi() {
  const app = new Hono()

  app.use('/api/*', cors())
  app.get('/healthz', (c) => c.json({ ok: true }))

  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${env.COLLAB_TOKEN}`) {
      return c.json({ error: { code: 'auth_failed', message: 'invalid token' } }, 401)
    }
    await next()
  })

  app.get('/api/docs', async (c) => {
    return c.json({ docs: await listDocs() })
  })

  app.post('/api/docs', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled'
    return c.json({ doc: await createDoc(title) }, 201)
  })

  app.get('/api/docs/:id', async (c) => {
    const doc = await getDoc(c.req.param('id'))
    if (!doc) return c.json({ error: { code: 'not_found', message: 'no such doc' } }, 404)
    return c.json({ doc })
  })

  if (existsSync(WEB_DIST)) {
    // Static assets, then SPA fallback to index.html for client-side routes.
    app.use('/*', serveStatic({ root: WEB_DIST }))
    app.get('/*', serveStatic({ root: WEB_DIST, path: 'index.html' }))
  } else {
    app.get('/', (c) => c.text('datadocs sync server (no web build)'))
  }

  return app
}
