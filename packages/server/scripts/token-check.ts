// Validates the user + dd_ CLI-token path (the flow the separate docs-cli repo
// will use) without needing a browser Clerk session.
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { DOC_TEXT_FIELD } from '@datadocs/core'
import { issueApiToken } from '../src/auth.js'
import { sql } from '../src/db/index.js'

const API = process.env.API_URL ?? 'http://localhost:3001'
const WS = process.env.WS_URL ?? 'ws://localhost:3001'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Fresh test user + token
const [user] = await sql<{ id: string }[]>`
  insert into users (email, name) values (${`tokencheck-${Date.now()}@test.local`}, 'Token Check')
  returning id
`
const { token } = await issueApiToken(user!.id, 'token-check')

const authed = (init?: RequestInit) => ({
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
})

// 1. Create a doc with the dd_ token
const createRes = await fetch(`${API}/api/docs`, authed({ method: 'POST', body: JSON.stringify({ title: 'CLI doc' }) }))
const { doc } = (await createRes.json()) as { doc: { id: string } }
check('create doc with dd_ token', createRes.status === 201 && !!doc?.id)

// 2. List shows it (scoped to this user)
const listRes = await fetch(`${API}/api/docs`, authed())
const { docs } = (await listRes.json()) as { docs: { id: string }[] }
check('listed doc is scoped to the token user', docs.length === 1 && docs[0]?.id === doc.id, `count=${docs.length}`)

// 3. WS connect to the owned doc with the dd_ token, edit, converge
const ydoc = new Y.Doc()
const provider = new HocuspocusProvider({ url: WS, name: doc.id, token, document: ydoc })
await new Promise<void>((res, rej) => {
  provider.on('synced', () => res())
  setTimeout(() => rej(new Error('ws sync timeout')), 8000)
}).then(
  () => {
    ydoc.getText(DOC_TEXT_FIELD).insert(0, 'pushed via CLI token\n')
    check('ws connect + edit with dd_ token (owned doc)', true)
  },
  (e) => check('ws connect + edit with dd_ token (owned doc)', false, e.message),
)
provider.destroy()

// 4. WS connect to a non-existent doc must be rejected
const ghost = new Y.Doc()
const gp = new HocuspocusProvider({
  url: WS,
  name: '00000000-0000-0000-0000-0000deadbeef',
  token,
  document: ghost,
})
await new Promise<void>((res) => {
  let settled = false
  const done = (ok: boolean, detail = '') => {
    if (settled) return
    settled = true
    check('ws to non-existent doc is rejected', ok, detail)
    res()
  }
  gp.on('authenticationFailed', () => done(true))
  gp.on('synced', () => done(false, 'unexpectedly synced'))
  setTimeout(() => done(gp.isSynced === false, 'no event; checking unsynced'), 5000)
})
gp.destroy()

await sql.end()
console.log(failures === 0 ? '\nall token checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
