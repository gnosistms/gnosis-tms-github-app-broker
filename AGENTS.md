# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

This is the GitHub App broker for Gnosis TMS: a small Express service that mints
GitHub App installation tokens, enforces team authorization, and proxies the GitHub
REST/GraphQL calls the desktop app cannot make itself (repo listings, repo
create/rename/delete, org membership, AI secret storage). The desktop app
(`Gnosis-TMS-tauri-app`) talks to it over HTTPS with a broker session token.

## Deployment (IMPORTANT)

**This is a DigitalOcean App Platform app that deploys from the pushed GitHub `main`
branch. A local commit does nothing — changes MUST be pushed to GitHub before
DigitalOcean can deploy them.** Every time you change the broker:

1. Commit.
2. **Push** (or merge the PR on GitHub, which has the same effect).
3. Confirm the DigitalOcean deploy picked it up before relying on the change —
   in particular, before shipping a desktop-app release that calls a new endpoint.

The service is **stateless**: no database, no disk persistence — only in-memory
caches (e.g. the project listing cache in `src/project-repos.js`), which empty on
every deploy or restart. Do not design features that assume server-side state
survives a restart.

## Key Locations

- `src/server.js` — Express app assembly; every `register*Routes` is wired here
- `src/config.js` — required env vars, validated at import time (tests must set
  them before importing app modules; see `src/team-ai.test.js` for the pattern)
- `src/security.js` — `ensureBrokerSession` middleware
- `src/installation-access.js` — per-installation authorization checks
- `src/github-app.js` — GitHub REST/GraphQL clients, installation token minting
- `src/installation-repos.js` — shared repo enumeration prelude used by all listings
- `src/installation-resources.js` — combined `/gnosis-resources` listing + digest
- `src/project-repos.js` / `src/glossary-repos.js` / `src/qa-list-repos.js` —
  per-type resource management (legacy listing endpoints live here and must keep
  working for older app versions)

## Development Commands

```bash
npm run dev    # local server with watch (needs env vars; see src/config.js)
npm test       # node --test src/*.test.js
```

## Webhook manifest

The combined `/gnosis-resources` listing serves from a per-installation in-memory
manifest kept current by GitHub webhooks (`src/installation-manifest.js`,
`src/webhook-routes.js`, `POST /webhooks/github`). The feature is dormant until
`GITHUB_APP_WEBHOOK_SECRET` is set; configuration lives in three places that must
agree: the DigitalOcean env var, the GitHub App webhook settings (URL
`<PUBLIC_BASE_URL>/webhooks/github`, the same secret, content type
application/json), and the App's event subscriptions (Push, Repository, Custom
property values). A 10-minute TTL bounds staleness from missed deliveries. The
manifest assumes a **single instance** — if the app is ever scaled out, extra
instances fall back to TTL freshness.

## Scheduled cleanup

- **Legacy listing endpoints** (`gnosis-projects`, `gnosis-glossaries`,
  `gnosis-qa-lists` GET listings in `src/project-routes.js`, `src/glossary-routes.js`,
  `src/qa-list-routes.js`, and their `listGnosis*ForInstallation` prelude wrappers):
  superseded by the combined `/gnosis-resources` endpoint on **2026-06-10**. Per Hans,
  they are safe to remove **any time after 2026-06-17** — provided a desktop-app
  release that uses the combined endpoint has actually shipped by then (the combined
  listing merged app-side in PR #100 but removal is only safe once a release
  containing it has been current for about a week). Keep the create/rename/delete
  routes; only the three GET listings are scheduled for removal.

## Rules

- **Compatibility** — released desktop app versions call the existing endpoints.
  Never remove or change the shape of an endpoint an older app release uses; add
  new endpoints alongside.
- **Deploy ordering** — when an app-repo change depends on a new broker endpoint,
  the broker must be pushed and deployed first.
- **Authorization** — every installation-scoped route goes through
  `ensureBrokerSession` plus the appropriate `ensureInstallationAccess` check.
  Match the strictness of the closest existing route.
