// Validates share-by-link: viewer link → access but canEdit=false; editor link
// → canEdit=true (upgrades a prior viewer grant). Bob starts with no access.
import { issueApiToken } from '../src/auth.js'
import { sql } from '../src/db/index.js'
import { ensurePersonalWorkspace } from '../src/workspaces.js'

const API = process.env.API_URL ?? 'http://localhost:3001'
let failures = 0
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`)
  if (!ok) failures++
}
async function mkUser(label: string) {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, name) values (${`${label}-${Date.now()}@t.local`}, ${label}) returning id
  `
  await ensurePersonalWorkspace(u!.id)
  return { id: u!.id, token: (await issueApiToken(u!.id, label)).token }
}
const authed = (t: string, init?: RequestInit) => ({
  ...init,
  headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...init?.headers },
})
const J = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) })

const alice = await mkUser('alice')
const bob = await mkUser('bob')

const { body: dc } = await J(await fetch(`${API}/api/docs`, authed(alice.token, { method: 'POST', body: '{"title":"Linkable"}' })))
const docId = dc.doc.id

// Bob has no access yet
check('bob has no access before any link', (await J(await fetch(`${API}/api/docs/${docId}`, authed(bob.token)))).status === 404)

// Alice mints a viewer link, Bob redeems it
const { body: vlink } = await J(await fetch(`${API}/api/docs/${docId}/links`, authed(alice.token, { method: 'POST', body: '{"role":"viewer"}' })))
check('create viewer link', !!vlink.token && vlink.role === 'viewer')
const r1 = await J(await fetch(`${API}/api/docs/${docId}/links/redeem`, authed(bob.token, { method: 'POST', body: JSON.stringify({ token: vlink.token }) })))
check('bob redeems viewer link', r1.status === 200)
const after1 = await J(await fetch(`${API}/api/docs/${docId}`, authed(bob.token)))
check('bob can now view', after1.status === 200)
check('bob is view-only (canEdit=false)', after1.body.canEdit === false, `canEdit=${after1.body.canEdit}`)

// Alice mints an editor link, Bob redeems it → upgraded to editor
const { body: elink } = await J(await fetch(`${API}/api/docs/${docId}/links`, authed(alice.token, { method: 'POST', body: '{"role":"editor"}' })))
await J(await fetch(`${API}/api/docs/${docId}/links/redeem`, authed(bob.token, { method: 'POST', body: JSON.stringify({ token: elink.token }) })))
const after2 = await J(await fetch(`${API}/api/docs/${docId}`, authed(bob.token)))
check('editor link upgrades bob to canEdit=true', after2.body.canEdit === true, `canEdit=${after2.body.canEdit}`)

// A viewer cannot create links (needs edit access) — use a fresh viewer
const carol = await mkUser('carol')
await J(await fetch(`${API}/api/docs/${docId}/links/redeem`, authed(carol.token, { method: 'POST', body: JSON.stringify({ token: (await J(await fetch(`${API}/api/docs/${docId}/links`, authed(alice.token, { method: 'POST', body: '{"role":"viewer"}' })))).body.token }) })))
const carolShare = await J(await fetch(`${API}/api/docs/${docId}/links`, authed(carol.token, { method: 'POST', body: '{"role":"editor"}' })))
check('viewer cannot create a share link', carolShare.status === 403)

await sql.end()
console.log(failures === 0 ? '\nall link checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
