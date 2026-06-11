// Validates comments: add over HTTP (writes to the Yjs map, mirrors to Postgres),
// list, resolve, and status filtering.
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

const [u] = await sql<{ id: string }[]>`insert into users (email,name) values (${`cm-${Date.now()}@t.local`},'CM') returning id`
const wsId = await ensurePersonalWorkspace(u!.id)
const token = (await issueApiToken(u!.id, 'cm')).token
const H = (b?: object) => ({
  method: b ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(b ? { body: JSON.stringify(b) } : {}),
})

const { body: dc } = await J(await fetch(`${API}/api/docs`, H({ title: 'Commented', workspaceId: wsId })))
const id = dc.doc.id

const add = await J(await fetch(`${API}/api/docs/${id}/comments`, H({ body: 'please tighten the intro' })))
check('add comment', add.status === 201 && !!add.body.comment?.id)
const cid = add.body.comment.id

const list = await J(await fetch(`${API}/api/docs/${id}/comments`, H()))
check('comment is mirrored + listed', list.body.comments.some((c: { id: string }) => c.id === cid))
check('listed comment has body', list.body.comments.find((c: { id: string }) => c.id === cid)?.body === 'please tighten the intro')

const openOnly = await J(await fetch(`${API}/api/docs/${id}/comments?status=open`, H()))
check('open filter includes it', openOnly.body.comments.some((c: { id: string }) => c.id === cid))

const resolve = await J(await fetch(`${API}/api/docs/${id}/comments/${cid}/resolve`, H({})))
check('resolve succeeds', resolve.status === 200)
const openAfter = await J(await fetch(`${API}/api/docs/${id}/comments?status=open`, H()))
check('resolved comment leaves open list', !openAfter.body.comments.some((c: { id: string }) => c.id === cid))
const resolved = await J(await fetch(`${API}/api/docs/${id}/comments?status=resolved`, H()))
check('resolved comment in resolved list', resolved.body.comments.some((c: { id: string }) => c.id === cid))

await sql.end()
console.log(failures === 0 ? '\nall comments checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
