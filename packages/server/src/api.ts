import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { createDoc, getDoc, listDocs } from './docs.js'

// Milestone-2 API: doc list/create behind the shared COLLAB_TOKEN.
// Real per-user auth + access control replace this in milestone 3.
export function createApi() {
  const app = new Hono()

  app.use('*', cors())
  app.get('/', (c) => c.text('datadocs sync server'))
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

  return app
}
