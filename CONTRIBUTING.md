# Contributing to mdocs

Thanks for your interest in mdocs — the web app (server + web editor + shared
core) behind [mdocs.datacompany.dev](https://mdocs.datacompany.dev). This repo is
**AGPL-3.0-only**; the separate [`mdocs` CLI](https://github.com/TheDataCo/mdocs)
is MIT.

## Developer Certificate of Origin (sign-off required)

Every commit must be signed off. By signing off you certify the
[Developer Certificate of Origin](https://developercertificate.org/) — in short,
that you wrote the change (or have the right to submit it) and agree it can be
distributed under this project's license.

Add the sign-off automatically with `-s`:

```sh
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer (the name and
email must be real and match your Git identity). PRs with unsigned commits can't
be merged.

> Note: contributions are accepted under AGPL-3.0-only. If we ever need to
> re-license or ship a closed hosted overlay, we'll ask contributors before using
> their changes outside these terms.

## Development setup

Requirements: Node ≥ 18, pnpm ≥ 10, a Postgres database (Railway, Neon, Supabase,
or local), and Clerk keys.

```sh
pnpm install
cp .env.example .env          # DATABASE_URL, CLERK_SECRET_KEY, COLLAB_TOKEN
pnpm db:push                  # create tables
pnpm dev:server               # API + sync on :3001
pnpm dev:web                  # editor on :5173
```

`COLLAB_TOKEN` must be a strong secret (16+ chars, not the example value) —
generate one with `openssl rand -hex 32`.

## Before you open a PR

CI runs these on every push and pull request; run them locally first:

```sh
pnpm lint                     # Biome
pnpm -r typecheck             # all packages
pnpm --filter @mdocs/web build
```

For server changes, the headless check scripts exercise the real sync/auth paths
against a running server:

```sh
pnpm --filter @mdocs/server sync-check      # convergence, auth, persistence
pnpm --filter @mdocs/server workspace-check # team access boundary
pnpm --filter @mdocs/server link-check      # viewer/editor share links
pnpm --filter @mdocs/server cli-auth-check  # device-auth flow
```

## Conventions

- Match the surrounding code's style — Biome handles linting (formatting is left
  to your editor; keep diffs minimal).
- Keep comments focused on the *why*, not the *what*.
- One logical change per PR; write a clear description of the problem and the fix.

## Reporting bugs & proposing features

Open an issue describing what you expected, what happened, and steps to
reproduce. For larger features, open an issue to discuss the approach before
investing in a PR.

## License

By contributing, you agree your contributions are licensed under
**AGPL-3.0-only**, the same license as this project.
