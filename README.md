# mdocs — Docs for Markdown

**Google Docs for markdown files.** Live multiplayer editing in the browser, a
first-class CLI for developers and agents, and plain markdown as the source of
truth. Live at **[mdocs.datacompany.dev](https://mdocs.datacompany.dev)**.

This repo is the **web app** (server + web editor + shared core). The terminal
client lives in its own repo: **[TheDataCo/mdocs](https://github.com/TheDataCo/mdocs)**
(`npm i -g @thedataco/mdocs`).

## Why

- **Google Docs** has the collaboration UX (live cursors, sharing, presence) but
  is hostile to markdown, git, CLIs, and agents.
- **Git + markdown** has versioning and tooling, but no live collaboration and
  merge conflicts everyone hates resolving.

mdocs sits in the middle: canonical document state is a CRDT (Yjs `Y.Text`),
markdown is its exact, lossless export. Concurrent edits merge automatically —
including edits an **agent** pushes from the CLI while humans type in the browser.

## What works today

**Editor & collaboration**
- Real-time collaborative markdown (CodeMirror 6 + Yjs + Hocuspocus) with
  presence avatars and live cursors
- Split **source + live preview**, or single-pane read mode (`⌘E`); collapsible
  sidebar and preview (`⌘P`); Tab/4-space indent & nested lists; "Copy for LLM"
- Inline everything — no modal prompts (rename, delete-confirm, share, workspace
  create/rename all happen in place)

**Workspaces & sharing**
- Personal + team workspaces (our own membership/roles/invites), a doc tree with
  drag-and-drop between workspaces, search, rename/delete
- Share a doc by **email** or by **link** — read-only or editor — with read-only
  enforced end to end (websocket + editor)

**Auth & persistence**
- **Clerk** sign-in for the web; per-user **`dd_` API tokens** for the CLI/agents;
  a server-only service token for tooling
- Durable append-only Yjs update log in Postgres (per-doc monotonic seq + snapshot
  compaction; history never deleted)
- **`doc_versions`** — point-in-time snapshots that serve as both document history
  and the merge base for CLI push

**CLI ([TheDataCo/mdocs](https://github.com/TheDataCo/mdocs))**

```sh
npm i -g @thedataco/mdocs
mdocs auth login
```

- `pull` / `push -m "why"` (server-side 3-way merge) / `new` / `cat` / `ls`
- `history` & `revert` — versions with author, source, and message
- `comments` — list / add / resolve; agent comments are signed as
  "you@example.com's agent" (`--as "Claude"`)
- `trash` — list, read, and restore recently deleted docs and workspaces
- `share` by email or link; `skills install` (Claude + Codex);
  `instructions` (an llm.txt-style guide for agents)

## Roadmap

- SSE notifications when an agent updates a doc
- Editor feel: inline live markdown styling, slash menu, code highlighting
- Purge job for trash items past their retention window

## Repo layout

```
packages/
  core/      @mdocs/core    shared types + (soon) the diff→merge protocol
  server/    @mdocs/server  Hocuspocus websocket sync + Hono HTTP API + Drizzle/Postgres
  web/       @mdocs/web      Vite + React + CodeMirror 6 editor (served by the server in prod)
```

pnpm workspaces — `web` imports `core` directly so every surface shares the same
types/semantics.

## Development

Requirements: Node ≥ 18, pnpm ≥ 10, a Postgres database (Railway, Neon, Supabase,
or local), and Clerk keys.

```sh
pnpm install
cp .env.example .env          # DATABASE_URL, CLERK_SECRET_KEY, COLLAB_TOKEN
pnpm db:push                  # create tables
pnpm dev:server               # API + sync on :3001
pnpm dev:web                  # editor on :5173
```

The server also has headless check scripts:

```sh
pnpm --filter @mdocs/server sync-check      # convergence, auth, persistence
pnpm --filter @mdocs/server workspace-check # team access boundary
pnpm --filter @mdocs/server link-check      # viewer/editor share links
pnpm --filter @mdocs/server cli-auth-check  # device-auth flow
```

## Self-hosting

The server is a single Node process serving both the API/websocket and the built
web app; it needs a `DATABASE_URL`, `CLERK_SECRET_KEY`, and a `COLLAB_TOKEN`. A
`railway.json` is included for Railway (`railway up`), but any Node host works.

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Commits must be signed off
(`git commit -s`), and `pnpm lint`, `pnpm -r typecheck`, and the web build run in
CI on every PR.

## License

**AGPL-3.0-only** (see [LICENSE](./LICENSE)) — free to self-host; if you run a
modified version as a network service, you must publish your changes. The
separate [`mdocs` CLI](https://github.com/TheDataCo/mdocs) is **MIT** for
frictionless adoption by tools and agents.
