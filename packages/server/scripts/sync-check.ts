// Milestone-1 exit-criteria check (run against a running server):
//   1. two clients converge on concurrent edits
//   2. a bad token is rejected
//   3. state survives reconnect (fresh client sees persisted content)
// Restart-survival is the same as (3) run after bouncing the server.
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { DOC_TEXT_FIELD } from '@mdocs/core'

const URL = process.env.SYNC_URL ?? 'ws://localhost:3001'
const TOKEN = process.env.COLLAB_TOKEN
if (!TOKEN) {
  console.error('Set COLLAB_TOKEN (the server no longer has a default service token).')
  process.exit(1)
}
const DOC = process.env.SYNC_DOC ?? '00000000-0000-0000-0000-00000000c0de'

function connect(token = TOKEN) {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({ url: URL, name: DOC, token, document: doc })
  return { doc, provider }
}

function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for: ${label}`))
      }
    }, 50)
  })
}

let failures = 0
function report(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// 1. Convergence
const a = connect()
const b = connect()
await until(() => a.provider.isSynced && b.provider.isSynced, 'initial sync')
const stamp = `[sync-check ${process.pid}]`
a.doc.getText(DOC_TEXT_FIELD).insert(0, `${stamp} from A\n`)
b.doc.getText(DOC_TEXT_FIELD).insert(0, `${stamp} from B\n`)
await until(
  () =>
    a.doc.getText(DOC_TEXT_FIELD).toString() === b.doc.getText(DOC_TEXT_FIELD).toString() &&
    a.doc.getText(DOC_TEXT_FIELD).toString().includes('from A') &&
    a.doc.getText(DOC_TEXT_FIELD).toString().includes('from B'),
  'convergence',
).then(
  () => report('two clients converge on concurrent edits', true),
  (e) => report('two clients converge on concurrent edits', false, e.message),
)

// 2. Auth rejection
const bad = connect('wrong-token')
await new Promise<void>((resolve) => {
  bad.provider.on('authenticationFailed', () => {
    report('bad token is rejected', true)
    resolve()
  })
  setTimeout(() => {
    report('bad token is rejected', bad.provider.isSynced === false, 'no auth failure event; checking unsynced')
    resolve()
  }, 5_000)
})
bad.provider.destroy()

// 3. Persistence across reconnect: give the debounced snapshot/log a moment,
// drop both clients, connect fresh, expect content.
await new Promise((r) => setTimeout(r, 500))
const expected = a.doc.getText(DOC_TEXT_FIELD).toString()
a.provider.destroy()
b.provider.destroy()
const c = connect()
await until(() => c.provider.isSynced, 'fresh client sync')
await until(
  () => c.doc.getText(DOC_TEXT_FIELD).toString() === expected,
  'fresh client sees persisted content',
).then(
  () => report('state survives reconnect (fresh client)', true),
  (e) => report('state survives reconnect (fresh client)', false, e.message),
)
c.provider.destroy()

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
