# mdocs CLI — Plan (for review)

> Separate repo `TheDataCo/mdocs`, published to npm as **`mdocs`** (binary
> `mdocs`). Installable `npm i -g mdocs` / `npx mdocs`. Node ESM + commander.
> Talks only to the public HTTP API + websocket; no Clerk SDK.

## Purpose

Make agents (and devs) first-class collaborators on mdocs documents from the
terminal: authenticate against the hosted app, list/pull docs, and push edits
that merge into the live document the same way a browser edit would.

## Auth — device flow (already built server-side)

`mdocs auth login`:
1. `POST /api/cli/auth/start` → `{ device_code, user_code, verification_uri_complete }`.
2. Open the browser to `…/cli-auth?code=USER_CODE`; print the code as fallback.
3. Poll `POST /api/cli/auth/poll {device_code}` every `interval`s until
   `approved` → receive a `dd_` token (one-time delivery), or `expired`.
4. Save `{ server, token }` to `~/.config/mdocs/config.json` (0600).

`mdocs auth logout` clears it. `mdocs whoami` → `GET /api/me`.
Server override: `--server` flag or `MDOCS_SERVER` (default
`https://mdocs.datacompany.dev`). Token also via `MDOCS_TOKEN` for CI/agents.

## Commands (v1 scope)

| Command | Endpoint | Notes |
|---|---|---|
| `auth login` / `logout` / `whoami` | cli auth + `/api/me` | device flow |
| `ls` | `GET /api/docs` | list accessible docs (id, title, workspace) |
| `pull <doc> [path]` | `GET /api/docs/:id/content` | write markdown to `path` (default `<title>.md`); record base in manifest |
| `push [path]` | websocket Yjs update | **the hard part — see below** |
| `diff [path]` | local | base vs working text |

`--json` on read commands; stable exit codes + error codes for agents.

## Local state

`.mdocs/manifest.json` in the working dir maps `path → { docId, server, baseText, baseHash }`.
Tokens live in `~/.config/mdocs/`, never in the manifest. Gitignore `.mdocs/`.

## The push problem (the moat — needs the most scrutiny)

A doc's canonical state is a Yjs `Y.Text` on the server, edited live. The CLI
has only the markdown text it pulled (the `base`) plus the user/agent's edited
version (the `working`). Naive "send the new text" would clobber concurrent
human edits. Plan (matches PLAN.md decision #4):

1. **Connect via the websocket** (HocuspocusProvider with Node `ws`) and sync to
   **server head** — the CLI now holds a real `Y.Doc`.
2. Compute the patch `base → working` (diff-match-patch).
3. Apply that patch onto **head text** with fuzzy/context matching.
4. Translate accepted hunks into `Y.Text` insert/delete ops on the head doc →
   the provider syncs them up. Disjoint edits merge cleanly.
5. Hunks that don't apply → exit `patch_conflict` with the rejected hunks; the
   agent re-pulls and retries.

Open questions for this call:
- **Transport for push**: reuse the websocket (real CRDT merge, but pulls in the
  hocuspocus provider + ws in Node), **or** add an HTTP `POST /api/docs/:id/updates`
  that accepts a Yjs update computed client-side? WS is more faithful; HTTP is
  simpler to ship and script.
- **Where does diff→Yjs-ops live**: publish `@datadocs/core` to npm, or vendor a
  copy into the mdocs repo? (Monorepo `core` currently isn't published.)
- **Auth token type for agents**: device-flow `dd_` token is per-user. Do we also
  want non-interactive `MDOCS_TOKEN` issuance for CI/agents (yes, supported via
  the app's CLI-token button + env var)?
- **Commit message / intent**: `push --message "…"` captured now (even before the
  history UI exists) so agent intent is recorded from day one.

## Build order (proposed)

1. Repo scaffold + `auth login/logout/whoami` + `ls` (proves auth + API). Publish a
   `0.1.0` so `npm i -g mdocs` works.
2. `pull` + manifest + `diff`.
3. `push` (the rebase pipeline) — the careful milestone.
4. SSE notifications, watch mode, etc. — later.

## Packaging

- `tsup` → single ESM bundle `dist/cli.js` with shebang; `bin: { mdocs }`.
- `files: ["dist"]`, `engines.node >= 18`, `prepublishOnly: tsup`.
- CI later; manual `npm publish` for `0.1.0`.
