// Validates the device-auth flow end to end: start → approve (as a user) →
// poll returns the token → the token works against the API.
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

// A user (with a dd_ token) stands in for the signed-in browser approving.
const [u] = await sql<{ id: string }[]>`insert into users (email, name) values (${`cliauth-${Date.now()}@t.local`}, 'CLI Auth') returning id`
await ensurePersonalWorkspace(u!.id)
const approverToken = (await issueApiToken(u!.id, 'approver')).token

const start = await J(await fetch(`${API}/api/cli/auth/start`, { method: 'POST' }))
check('start returns device + user code', !!start.body.device_code && !!start.body.user_code, start.body.user_code)

const pollPending = await J(await fetch(`${API}/api/cli/auth/poll`, { method: 'POST', body: JSON.stringify({ device_code: start.body.device_code }), headers: { 'Content-Type': 'application/json' } }))
check('poll is pending before approval', pollPending.body.status === 'pending')

const approve = await J(await fetch(`${API}/api/cli/auth/approve`, { method: 'POST', headers: { Authorization: `Bearer ${approverToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_code: start.body.user_code }) }))
check('approve succeeds', approve.status === 200)

const pollApproved = await J(await fetch(`${API}/api/cli/auth/poll`, { method: 'POST', body: JSON.stringify({ device_code: start.body.device_code }), headers: { 'Content-Type': 'application/json' } }))
check('poll returns approved + token', pollApproved.body.status === 'approved' && !!pollApproved.body.token)

const cliToken = pollApproved.body.token
const docs = await J(await fetch(`${API}/api/docs`, { headers: { Authorization: `Bearer ${cliToken}` } }))
check('issued token works against the API', docs.status === 200 && Array.isArray(docs.body.docs))

const pollAgain = await J(await fetch(`${API}/api/cli/auth/poll`, { method: 'POST', body: JSON.stringify({ device_code: start.body.device_code }), headers: { 'Content-Type': 'application/json' } }))
check('token is one-time (gone after delivery)', pollAgain.body.status === 'expired')

await sql.end()
console.log(failures === 0 ? '\nall cli-auth checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
