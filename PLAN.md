# DataDocs — Plan

> Google Docs for markdown files. Live multiplayer editing in the browser, first-class
> CLI access for developers and agents, markdown as the universal interchange format.

*Rev 2 — incorporates external design review (codex, 2026-06-06). Major changes:
honest source-of-truth framing, rebase-on-push CLI sync algorithm, persistence
invariants, sidecar manifest redesign, block-level position mapping for MVP,
markdown sanitization, no viewer role in MVP.*

## Vision

There's a gap between two worlds:

- **Google Docs** has the collaboration UX (live cursors, comments, suggestions,
  history) but is hostile to markdown, git, CLIs, and agents.
- **Git/markdown** has versioning, diffs, and tooling, but no live collaboration,
  no comment UX, and merge conflicts that humans (and agents) hate resolving.

DataDocs sits in the middle: a collaborative markdown editor where the **canonical
document state is a CRDT (`Y.Text`)** and **markdown text is its exact, lossless
exported representation** — what the web editor shows, what the CLI pulls, what
agents edit. Concurrent edits merge automatically; the CLI makes agents
first-class collaborators.

**Text policy:** documents are UTF-8, `\n` line endings, plain text (the CRDT
stores exactly what was typed — no normalization beyond line endings on import).

**Open source core** — self-hosting = one Node server + any Postgres
`DATABASE_URL` (managed Postgres like Neon/Supabase, or your own; no email
service required) — monetized via a hosted version (multiplayer infra, orgs,
SSO, billing).

## Feature set (full product)

| Feature | MVP | Notes |
|---|---|---|
| Live shared editor (presence, cursors) | ✅ | The headline feature |
| Raw markdown + rendered preview views | ✅ | Editing only ever happens in raw view |
| CLI: `login`, `ls`, `new`, `pull`, `push`, `diff` | ✅ | Agent-first; JSON output + stable error codes |
| Backend: ws sync + HTTP API + Postgres | ✅ | |
| Minimal auth (accounts, API tokens, invite/link sharing) | ✅ | Everyone with access can edit (no viewer role yet) |
| Markdown sanitization in preview | ✅ | XSS is a day-one concern, not a polish item |
| Comments (threaded, anchored, resolvable) | ⏳ designed-for | Anchors = relative position + excerpt + state |
| Suggestion mode (tracked changes, accept/reject) | ⏳ designed-for | Model is an **open design question** (see below) |
| Edit history (fine-grained, attributed) | ⏳ designed-for | Update log is the *substrate*; product history needs a changesets layer |
| Named versions / snapshots ("multi edits" as changesets) | ⏳ designed-for | |
| Viewer role / read-only access | ❌ later | MVP: all collaborators are editors |
| Orgs, billing, SSO, token scopes, audit trails | ❌ later | Hosted-version monetization layer |
| Git integration (two-way repo sync) | ❌ later | CLI is git-*friendly* from day one |
| WYSIWYG view | ❌ later | Raw-text truth makes this safe to add |

## MVP definition

**In:** live shared markdown editor (web, multi-cursor presence) · CLI · backend
(websocket sync + HTTP API + Postgres) · minimal auth · preview sanitization.

**The MVP demo:** two browsers live-editing with visible cursors, while an agent
runs `dd pull`, edits the file with sed, `dd push` — and the change rebases onto
the live document and merges cleanly; if the agent touched the same text a human
just rewrote, the CLI reports a structured `patch_conflict` instead of silently
mangling the doc.

## Key design decisions

1. **Yjs as the CRDT** (over Loro/Automerge). Most mature ecosystem: Hocuspocus
   provides the websocket sync server, `y-codemirror.next` provides the editor
   binding + presence. Doc body is a single `Y.Text`. Undo/redo via
   `Y.UndoManager` scoped to local origin (your undo never reverts someone
   else's edit).

2. **Persist the full update log, not just latest state — as sync/audit
   substrate.** Postgres stores append-only Yjs updates plus periodic compacted
   snapshots. This preserves the raw material for attributed history, but
   product-grade history (readable diffs, named changesets, grouping by
   user/session) is an explicit later layer (`changesets`) built on top —
   it does *not* fall out of the log for free. Retention policy is decided
   separately from sync compaction (compaction never deletes updates).

3. **Comment/suggestion anchors are designed now, built later.** An anchor is
   *not* just a `Y.RelativePosition` — it's: encoded relative positions
   (start/end) **+ quoted text excerpt + anchor state**
   (`valid` / `orphaned` / `deleted_text`). Relative positions survive
   concurrent edits; the excerpt + state handle the cases where the anchored
   text was deleted or the range collapsed. Reserve the schema; build nothing.
   **Suggestion mode's data model is an open design question** — overlay
   objects (pending hunks that don't touch canonical text until accepted) vs
   inline CRDT marks — to be prototyped before building, not assumed solved.

4. **CLI push = rebase, then merge.** The naive version (diff local text against
   the stale pulled base, apply to the base Y.Doc, send the update) produces
   structurally-valid but semantically-wrong merges when others edited the same
   region — inserts landing in odd places, deletes removing rewritten text.
   Instead, `dd push`:

   1. Fetch updates since the base state vector → advance local Y.Doc to
      **server head**.
   2. Compute the patch `base text → local text` (diff-match-patch).
   3. Apply the patch to **head text** with context-aware fuzzy matching.
   4. Hunks that apply cleanly → translate to `Y.Text` ops on the
      head-state doc → send the update blob (with idempotency key).
   5. Hunks that fail → exit with structured `patch_conflict` listing the
      rejected hunks, so an agent can re-pull, re-reason, and retry.

   Net effect: non-overlapping concurrent work merges automatically (the common
   case); genuinely overlapping edits surface as explicit, machine-readable
   conflicts instead of silent corruption. This algorithm **is** the moat and
   gets the majority of the engineering budget.

5. **Raw markdown is the only editing surface.** The rendered view is a
   read-only, **sanitized** projection. No contenteditable, no lossy md↔rich
   conversion anywhere — web editor, CLI, and agents all operate on the same
   text.

## Architecture

```
┌─────────┐   websocket (live)  ┌──────────────────┐
│ Web app │◄───────────────────►│      Server      │──► Postgres
│ (editor)│                     │ Hocuspocus (ws)  │    - doc_updates (append-only)
└─────────┘                     │ Hono (HTTP API)  │    - doc_snapshots
┌─────────┐   HTTP (pull/push)  │ auth, docs CRUD  │    - users, api_tokens
│   CLI   │◄───────────────────►│                  │    - docs, doc_access, link_shares
│ (agents)│                     └──────────────────┘    - [reserved: comments,
└─────────┘                                               suggestions, changesets]
```

### Repo layout (TypeScript monorepo)

```
datadocs/
  packages/
    core/      shared: types, diff/rebase/Yjs-ops pipeline, API client (cli + web)
    server/    Hocuspocus (ws sync) + Hono (HTTP API) + Drizzle ORM + Postgres
    web/       Vite + React + CodeMirror 6 + y-codemirror.next + remark preview
    cli/       commander-based CLI, uses core
```

pnpm workspaces: `cli` and `web` import `core` directly (`workspace:*`) — the
diff/rebase/Yjs pipeline and API client are written once, shared everywhere.
Dev and prod both connect to a managed Postgres (Neon) via `DATABASE_URL` —
no Docker required; an optional compose file for self-hosters can come later.

### Postgres schema (MVP)

- `users` — id, email, name, created_at
- `api_tokens` — id, user_id, token_hash, name, last_used_at, created_at
- `docs` — id, title, owner_id, created_at, updated_at, deleted_at (soft delete)
- `doc_updates` — doc_id, **seq (per-doc monotonic)**, update (bytea), author_id,
  origin (`websocket` | `http`), client_id, request_id (idempotency), created_at
  (server clock). PK (doc_id, seq).
- `doc_snapshots` — doc_id, snapshot (bytea), state_vector (bytea),
  **upto_seq (inclusive)**, created_at
- `doc_access` — doc_id, user_id, role (`owner` | `editor`), unique (doc_id, user_id)
- `link_shares` — id, doc_id, token_hash, created_by, expires_at, revoked_at

Reserved for later (don't build, just don't paint over):

- `comments` — doc_id, author_id, body, state (open/resolved), anchor_start
  (bytea, encoded Y.RelativePosition), anchor_end, anchor_excerpt (text),
  anchor_state (`valid`/`orphaned`/`deleted_text`), parent_comment_id, timestamps
- `suggestions` — doc_id, author_id, state (pending/accepted/rejected), hunks —
  **schema TBD pending model prototype**
- `changesets` — grouped, human-readable history events (later layer over the log)

### Persistence invariants

- Updates are appended **transactionally** with a per-doc monotonic `seq`
  (assigned under a per-doc advisory lock or serialized writer) — append-then-
  broadcast, never the reverse.
- Update writes are **idempotent** via `request_id` (Hocuspocus hook retries and
  CLI retries must not double-apply rows; Yjs merge is idempotent, the log
  shouldn't lie about history).
- Doc load = latest snapshot + updates where `seq > upto_seq` — safe under
  concurrent writes because seq is monotonic and snapshots record exact bounds.
- Compaction writes a new snapshot; it **never deletes** `doc_updates` rows
  (retention is a separate, explicit policy decision).

### Sync API (HTTP, for CLI)

- `GET  /docs/:id/sync-state` → encoded Yjs state + state vector + doc metadata
- `GET  /docs/:id/updates?since_vector=…` → updates the client is missing
- `POST /docs/:id/updates` — body: update blob + base state vector +
  idempotency key → returns accepted head state vector
- Plus: auth endpoints, doc CRUD, access management.

Authorization is enforced in **both** layers: HTTP middleware and Hocuspocus
`onAuthenticate`/`beforeHandleMessage` hooks (a websocket connection to a doc
room requires edit access to that doc; awareness state never crosses docs).

## Editor spec (web)

### View modes

- **Raw** — CodeMirror 6 source editor. **The only mode where editing happens.**
  **Default on opening a doc** (everyone with access is an editor in MVP);
  last-used mode remembered per user/doc.
- **Preview** — rendered markdown (remark + **rehype-sanitize**: raw HTML
  sanitized, dangerous protocols stripped), read-only.

### Transitions

- `Cmd+E` (`Ctrl+E` elsewhere) — universal toggle, works in both modes.
  (Deliberately *not* `Cmd+Shift+V`, which is paste-without-formatting.)
- `Shift+V` in preview → raw (preview is read-only, so bare keys are free).
- **Auto-enter raw on edit intent:** any printable keypress in preview, or
  double-click on text, switches to raw with the cursor at the corresponding
  source position. "When editing, always raw" — made automatic.

### Position mapping (MVP: block-level)

- Render via remark with source positions retained; map **rendered blocks ↔
  source line starts**. Toggling preserves scroll to the nearest block;
  double-click-to-edit lands at the start of the clicked block. Exact inline
  (character-level) mapping is explicitly out of MVP scope — it's a tarpit
  (nested inlines, tables, code fences, soft wraps) and block-level is enough
  for the UX to feel right.

### Presence & undo

- Avatars of connected users in both modes; live cursors render in raw mode.
- Undo = `Y.UndoManager` tracking only local-origin transactions; verified
  against the "undo after a remote edit landed mid-typing" case.

## CLI spec

Binary name TBD — **not `dd`** (unix collision; decide before implementation;
candidates: `ddoc`, `mdoc`, `datadocs` with short alias).

- `login` — obtain/store an API token (paste-token first; device-code later)
- `ls` — list accessible docs
- `new <file.md>` — create a server doc from a local file (title from first
  `# heading`, falling back to filename; title is doc metadata, not doc content)
- `pull <doc> [path]` — fetch doc as `.md` + record base state in the manifest
- `push [path]` — the rebase-then-merge algorithm (design decision 4)
- `diff [path]` — local changes vs base; `--remote` to also diff vs server head
- `--json` everywhere; stable machine-readable error codes:
  `auth_failed`, `not_found`, `permission_denied`, `stale_manifest`,
  `patch_conflict` (with rejected hunks), `network`, `server_error`

### Local state: manifest, not per-file sidecars

`.datadocs/manifest.json` (one per directory tree, gitignored) maps
`path → { doc_id, server_url, base_seq }`, with base doc state stored by doc id
in `.datadocs/state/<doc_id>` (base text hash + encoded Yjs state + state
vector). Properties:

- File renames/copies are explicit (`mv` updates the manifest entry, or push
  fails with `stale_manifest` rather than guessing).
- **No secrets in the manifest** — tokens live in `~/.config/datadocs/`.
- A failed push never mutates base state; only a confirmed server ack advances it.
- Another machine without `.datadocs/` simply can't push — it must `pull` first
  (correct by construction, never silently wrong).

## Build milestones

1. **Sync core** — monorepo scaffold (pnpm workspaces), hosted Postgres (Neon)
   via `DATABASE_URL`, Hocuspocus with Postgres persistence (transactional
   update log + snapshot compaction).
   Exit criteria — not just two happy tabs: reload-from-Postgres after server
   restart, client reconnect after network drop, auth-gated room access,
   duplicate sessions from one user, and a large-doc (1MB) smoke test.
2. **Web app** — doc list, editor page: CodeMirror + presence cursors, sanitized
   preview, `Cmd+E` toggle, block-level position mapping, `Y.UndoManager`.
3. **HTTP API + auth** — accounts (email/password — no email-sending dependency
   for self-host), API tokens, doc CRUD + access + link shares, `login`.
4. **CLI** — `ls`, `new`, `pull`, `push`, `diff`, with the rebase-on-push
   pipeline and `patch_conflict` flow in `core`. Ends with the headline demo:
   agent pushes into a live editing session — clean merge on disjoint edits,
   structured conflict on overlapping ones.
5. **Ship-ready** — README, self-host path: Node server + `DATABASE_URL`
   (migrations, base-URL/CORS/ws-origin config; optional compose file as a
   convenience), license decision (AGPL protects
   the hosted business; Apache maximizes adoption — decide before first public
   commit).

## Effort honesty

Milestones 1–2 are where the libraries help most, but they're not free:
Hocuspocus hooks are not a transaction system (the persistence invariants above
are ours to enforce), and ws auth, reconnect, and undo edge cases are real work.
The single biggest line item is milestone 4's diff→rebase→Yjs-ops pipeline with
conflict detection — roughly half the MVP effort, and exactly the part that makes
this different from every other markdown editor.

## Open questions

- License: AGPL vs Apache-2.0 (decide before first public commit)
- Update-log retention policy (keep forever vs windowed once `changesets` exist —
  affects storage cost and deletion/privacy obligations)
- CLI binary name (not `dd`)
- Suggestion-mode data model: overlay hunks vs inline CRDT marks (prototype
  before building)
- Hosted-version auth upgrade path (magic links / OAuth) — self-host stays
  email-free
