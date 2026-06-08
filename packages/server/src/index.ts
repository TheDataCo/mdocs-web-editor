import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { serve } from '@hono/node-server'
import { Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { createApi } from './api.js'
import { env } from './env.js'
import { appendUpdate, ensureDoc, loadDocState, saveSnapshot } from './persistence.js'

const hocuspocus = new Hocuspocus({
  // Milestone-1 auth: shared secret. Real per-user tokens land in milestone 3;
  // authorization stays enforced here (ws layer), not only in the HTTP API.
  async onAuthenticate({ token }) {
    if (token !== env.COLLAB_TOKEN) {
      throw new Error('unauthorized')
    }
  },

  async onLoadDocument({ documentName, document }) {
    await ensureDoc(documentName)
    const persisted = await loadDocState(documentName)
    Y.applyUpdate(document, Y.encodeStateAsUpdate(persisted))
    persisted.destroy()
    return document
  },

  // Fires per client-originated update: append to the log before the hook
  // resolves (append-then-broadcast).
  async onChange({ documentName, update, context }) {
    await appendUpdate(documentName, update, {
      origin: 'websocket',
      clientId: context?.clientId ?? null,
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
  console.log(`datadocs server (http + ws) listening on :${info.port}`)
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
