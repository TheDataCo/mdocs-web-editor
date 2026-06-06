import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { env } from './env.js'
import { appendUpdate, ensureDoc, loadDocState, saveSnapshot } from './persistence.js'

const server = new Server({
  port: env.PORT,

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

server.listen().then(() => {
  console.log(`datadocs sync server listening on :${env.PORT}`)
})
