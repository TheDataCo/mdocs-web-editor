// Validates team workspaces + the access boundary: a non-member is denied a
// team doc until invited, then gains both API and websocket access.
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { issueApiToken } from '../src/auth.js'
import { sql } from '../src/db/index.js'
import { ensurePersonalWorkspace } from '../src/workspaces.js'

const API = process.env.API_URL ?? 'http://localhost:3001'
const WS = process.env.WS_URL ?? 'ws://localhost:3001'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function mkUser(label: string) {
  const email = `${label}-${Date.now()}@test.local`
  const [u] = await sql<{ id: string }[]>`insert into users (email, name) values (${email}, ${label}) returning id`
  await ensurePersonalWorkspace(u!.id)
  const { token } = await issueApiToken(u!.id, label)
  return { id: u!.id, email, token }
}
const authed = (token: string, init?: RequestInit) => ({
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
})
const wsReachable = (token: string, docId: string) =>
  new Promise<boolean>((resolve) => {
    const p = new HocuspocusProvider({ url: WS, name: docId, token, document: new Y.Doc() })
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      p.destroy()
      resolve(v)
    }
    p.on('synced', () => finish(true))
    p.on('authenticationFailed', () => finish(false))
    setTimeout(() => finish(p.isSynced), 5000)
  })

const alice = await mkUser('alice')
const bob = await mkUser('bob')

// Alice creates a team workspace + a doc in it
const wsRes = await fetch(`${API}/api/workspaces`, authed(alice.token, { method: 'POST', body: JSON.stringify({ name: 'Team A' }) }))
const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
check('create team workspace', wsRes.status === 201 && !!workspace?.id)

const docRes = await fetch(`${API}/api/docs`, authed(alice.token, { method: 'POST', body: JSON.stringify({ title: 'Team doc', workspaceId: workspace.id }) }))
const { doc } = (await docRes.json()) as { doc: { id: string } }
check('create doc in team workspace', docRes.status === 201 && !!doc?.id)

// Bob (non-member) cannot see it or open it
const bobList1 = (await (await fetch(`${API}/api/docs`, authed(bob.token))).json()) as { docs: unknown[] }
check('non-member does NOT see the team doc', bobList1.docs.length === 0, `saw ${bobList1.docs.length}`)
check('non-member ws connect is rejected', (await wsReachable(bob.token, doc.id)) === false)

// Alice invites Bob (exists → added directly)
const invRes = await fetch(`${API}/api/workspaces/${workspace.id}/invitations`, authed(alice.token, { method: 'POST', body: JSON.stringify({ email: bob.email }) }))
const inv = (await invRes.json()) as { result: { status: string } }
check('invite existing user adds them', invRes.status === 201 && inv.result.status === 'added')

// Bob now sees the workspace + doc, and can open it
const bobWs = (await (await fetch(`${API}/api/workspaces`, authed(bob.token))).json()) as { workspaces: { id: string }[] }
check('member sees the team workspace', bobWs.workspaces.some((w) => w.id === workspace.id))
const bobList2 = (await (await fetch(`${API}/api/docs`, authed(bob.token))).json()) as { docs: { id: string }[] }
check('member sees the team doc', bobList2.docs.some((d) => d.id === doc.id))
check('member ws connect succeeds', (await wsReachable(bob.token, doc.id)) === true)

await sql.end()
console.log(failures === 0 ? '\nall workspace checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
