// Validates server-side push: clean 3-way merge applies to head + records a
// version; a divergent edit against a stale base conflicts (409).
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

const [u] = await sql<{ id: string }[]>`insert into users (email, name) values (${`push-${Date.now()}@t.local`}, 'Push') returning id`
const wsId = await ensurePersonalWorkspace(u!.id)
const token = (await issueApiToken(u!.id, 'push')).token
const H = (b?: object) => ({
  method: b ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(b ? { body: JSON.stringify(b) } : {}),
})

// New doc, pull base (empty), push initial content
const { body: dc } = await J(await fetch(`${API}/api/docs`, H({ title: 'Push doc', workspaceId: wsId })))
const id = dc.doc.id
const pull1 = await J(await fetch(`${API}/api/docs/${id}/pull`, H()))
const baseN = Number(pull1.body.version.n)
const push1 = await J(await fetch(`${API}/api/docs/${id}/push`, H({ baseVersion: baseN, content: '# Title\n\nfirst line\n', message: 'init' })))
check('clean push succeeds', push1.status === 200 && !!push1.body.version, `status=${push1.status}`)
const content1 = await (await fetch(`${API}/api/docs/${id}/content`, H())).text()
check('head reflects pushed content', content1.includes('# Title') && content1.includes('first line'))

// Disjoint merge: base = the version we just pushed; add a new trailing line.
const pull2 = await J(await fetch(`${API}/api/docs/${id}/pull`, H()))
const base2 = Number(pull2.body.version.n)
const push2 = await J(await fetch(`${API}/api/docs/${id}/push`, H({ baseVersion: base2, content: '# Title\n\nfirst line\nsecond line\n', message: 'add line' })))
check('disjoint push merges cleanly', push2.status === 200)

// Conflict: push against the STALE empty base with a different line-1 change.
const conflict = await J(await fetch(`${API}/api/docs/${id}/push`, H({ baseVersion: baseN, content: '# DIFFERENT\n\nfirst line\nsecond line\n', message: 'conflicting' })))
check('stale divergent push conflicts (409)', conflict.status === 409 && conflict.body.error?.code === 'patch_conflict', `status=${conflict.status}`)

// Versions accumulated
const versions = await J(await fetch(`${API}/api/docs/${id}/versions`, H()))
check('versions recorded for pushes', versions.body.versions.length >= 3, `count=${versions.body.versions.length}`)

await sql.end()
console.log(failures === 0 ? '\nall push checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
