import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { serve } from '@hono/node-server'
import { Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { createApi } from './api.js'
import { authenticate, type Principal } from './auth.js'
import { canAccess, canEdit, docExists } from './docs.js'
import { env } from './env.js'
import { appendUpdate, ensureDoc, loadDocState, saveSnapshot } from './persistence.js'

interface ConnContext {
  principal: Principal
}

const hocuspocus = new Hocuspocus({
  // Authenticate the connection (Clerk JWT, dd_ CLI token, or service token) and
  // authorize access to this specific doc. Returning a value sets the context.
  async onAuthenticate({ token, documentName, connectionConfig }): Promise<ConnContext> {
    const principal = await authenticate(token)
    if (!principal) throw new Error('unauthorized')

    if (principal.kind === 'user') {
      // Real users may only open existing docs they can access (workspace
      // membership or an explicit share). Service token may create docs.
      if (!(await docExists(documentName))) throw new Error('not found')
      if (!(await canAccess(principal, documentName))) throw new Error('forbidden')
      // Viewer-only shares connect read-only: Hocuspocus drops their doc updates.
      if (!(await canEdit(principal, documentName))) connectionConfig.readOnly = true
    }
    return { principal }
  },

  async onLoadDocument({ documentName, document, context }) {
    // Service connections lazily create docs (used by sync-check / tooling).
    if ((context as ConnContext)?.principal?.kind === 'service') {
      await ensureDoc(documentName)
    }
    const persisted = await loadDocState(documentName)
    Y.applyUpdate(document, Y.encodeStateAsUpdate(persisted))
    persisted.destroy()
    return document
  },

  // Fires per client-originated update: append to the log before the hook
  // resolves (append-then-broadcast), attributed to the connection's user.
  async onChange({ documentName, update, context }) {
    const principal = (context as ConnContext)?.principal
    await appendUpdate(documentName, update, {
      origin: 'websocket',
      authorId: principal?.kind === 'user' ? principal.userId : null,
    })
  },

  // Debounced by Hocuspocus — this is our snapshot compaction trigger.
  async onStoreDocument({ documentName, document }) {
    await saveSnapshot(documentName, document)
  },
})

// One port: Hono answers HTTP, websocket upgrades go to Hocuspocus.
const app = createApi()
const httpServer = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`mdocs server (http + ws) listening on :${info.port}`)
}) as HttpServer

// Hocuspocus v4 takes a fetch-style Request; adapt the node upgrade request
// (only url/headers matter — upgrade requests have no body).
function toFetchRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else if (value !== undefined) headers.set(key, value)
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
}

// handleConnection doesn't attach socket listeners itself — the integration
// feeds it messages and the close event (same contract the built-in Server
// fulfils via crossws).
const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    const connection = hocuspocus.handleConnection(ws, toFetchRequest(request))
    ws.on('message', (data: Buffer) => connection.handleMessage(new Uint8Array(data)))
    ws.on('close', (code, reason) =>
      connection.handleClose({ code, reason: reason.toString() } as CloseEvent),
    )
    ws.on('error', (error) => {
      console.error('websocket error:', error)
    })
  })
})
