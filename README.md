# mdocs — Docs for Markdown

**Google Docs for markdown files.** Live multiplayer editing in the browser,
first-class CLI access for developers and agents, plain markdown as the
interchange format. Live at [mdocs.datacompany.dev](https://mdocs.datacompany.dev).

> Repo/package names use `datadocs` internally; the product is **mdocs**.

> ⚠️ Early development — currently at milestone 1 of 5 (sync core). See
> [PLAN.md](./PLAN.md) for the full design and roadmap.

## Why

- **Google Docs** has the collaboration UX (live cursors, comments, suggestions,
  history) but is hostile to markdown, git, CLIs, and agents.
- **Git + markdown** has versioning, diffs, and tooling, but no live
  collaboration and merge conflicts everyone hates resolving.

datadocs sits in the middle: canonical document state is a CRDT (Yjs `Y.Text`),
markdown text is its exact, lossless export. Concurrent edits merge
automatically — including edits pushed from the CLI by an agent while humans
type in the browser.

## What works today

- Live collaborative markdown editing (CodeMirror 6 + Yjs + Hocuspocus) with
  presence cursors
- Durable persistence: append-only Yjs update log in Postgres with per-doc
  monotonic sequencing + snapshot compaction (compaction never deletes history)
- Token-gated websocket access
- `sync-check` script verifying convergence, auth rejection, and persistence
  across reconnect/restart

Coming next (see [PLAN.md](./PLAN.md)): doc list + preview/raw view toggle,
HTTP API + real auth, and the CLI with rebase-on-push merge (`pull` / `push` /
`diff` with structured conflict reporting for agents).

## Repo layout

```
packages/
  core/      shared types + (soon) the diff→rebase→Yjs-ops pipeline
  server/    Hocuspocus websocket sync + Drizzle/Postgres persistence
  web/       Vite + React + CodeMirror 6 editor
  cli/       (milestone 4)
```

pnpm workspaces — `web` and the future `cli` import `core` directly, so every
surface shares the same merge semantics.

## Development

Requirements: Node ≥ 22, pnpm ≥ 10, a Postgres database (any provider —
Railway, Neon, Supabase, or local).

```sh
pnpm install
cp .env.example .env          # set DATABASE_URL (and optionally COLLAB_TOKEN)
pnpm db:push                  # create tables
pnpm dev:server               # sync server on :3001
pnpm dev:web                  # editor on :5173 — open two tabs to see live sync
```

Verify the sync core against a running server:

```sh
pnpm --filter @datadocs/server sync-check
```

## Self-hosting

The server is a single Node process; all it needs is a `DATABASE_URL` and a
`COLLAB_TOKEN`. A `railway.json` is included for Railway deploys
(`railway up`), but any Node host works.

## License

TBD before first release (AGPL vs Apache-2.0 — tracked in
[PLAN.md](./PLAN.md#open-questions)).
