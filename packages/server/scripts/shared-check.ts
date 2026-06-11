// Validates the Shared view: a doc shared from Alice to Bob shows in BOTH
// users' /api/docs/shared, with the owner (Alice) attributed.
import { issueApiToken } from '../src/auth.js'
import { sql } from '../src/db/index.js'
import { ensurePersonalWorkspace } from '../src/workspaces.js'

const API = process.env.API_URL ?? 'http://localhost:3001'
let failures = 0
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
  if (!ok) failures++
}
const J = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) })

async function mk(label: string) {
  const email = `${label}-${Date.now()}@t.local`
  const [u] = await sql<{ id: string }[]>`insert into users (email,name) values (${email},${label}) returning id`
  const wsId = await ensurePersonalWorkspace(u!.id)
  return { id: u!.id, email, wsId, token: (await issueApiToken(u!.id, label)).token }
}
const H = (t: string, b?: object) => ({
  method: b ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  ...(b ? { body: JSON.stringify(b) } : {}),
})

const alice = await mk('alice')
const bob = await mk('bob')
const { body: dc } = await J(await fetch(`${API}/api/docs`, H(alice.token, { title: 'Shared Doc', workspaceId: alice.wsId })))
const id = dc.doc.id

// Before sharing: not in Bob's shared, not in Alice's shared
check('bob shared empty before share', (await J(await fetch(`${API}/api/docs/shared`, H(bob.token)))).body.docs.length === 0)

await J(await fetch(`${API}/api/docs/${id}/share`, H(alice.token, { email: bob.email })))

const bobShared = (await J(await fetch(`${API}/api/docs/shared`, H(bob.token)))).body.docs
check('bob sees the shared doc', bobShared.some((d: { id: string }) => d.id === id))
check('owner shown as alice', bobShared.find((d: { id: string }) => d.id === id)?.owner_email === alice.email, bobShared[0]?.owner_email)

const aliceShared = (await J(await fetch(`${API}/api/docs/shared`, H(alice.token)))).body.docs
check('alice sees it under shared-out', aliceShared.some((d: { id: string }) => d.id === id))

await sql.end()
console.log(failures === 0 ? '\nall shared checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
