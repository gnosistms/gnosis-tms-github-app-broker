# Gnosis TMS GitHub App Broker

Small Node/Express broker for the Gnosis TMS desktop app.

This service uses two GitHub auth modes together:

- GitHub OAuth authenticates the human user to the broker
- GitHub App authentication lets the broker act on installed orgs and repos

That means the desktop app never ships the GitHub App private key, while the broker can still
enforce "which signed-in user is allowed to operate on which installation."

## Flow

1. The desktop app opens `GET /auth/github/start` in the user's browser.
2. The broker sends the user through GitHub OAuth.
3. GitHub redirects back to the broker at `/auth/github/callback`.
4. The broker creates a broker session and redirects back to the desktop callback URL.
5. The desktop app stores the broker session token.
6. The desktop app calls broker API routes with that broker session token.
7. The broker verifies the user, checks org membership/admin access, and then uses GitHub App
   installation tokens server-side for GitHub API access.

The GitHub App installation flow still works through:

- `GET /github-app/install/start`
- `GET /github-app/install/callback`

## Required environment variables

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `BROKER_STATE_SECRET`

## Optional environment variables

- `PORT`
- `BROKER_TOKEN`
- `ALLOWED_DESKTOP_CALLBACK_PREFIXES`

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## GitHub OAuth app settings

Create a GitHub OAuth app for broker sign-in and set its callback URL to:

`https://YOUR_DIGITALOCEAN_DOMAIN/auth/github/callback`

For local development, if you expose the broker locally, the callback should point at your local
broker host instead.

The broker currently requests the `read:org` scope so it can verify which organizations the signed-in
user belongs to and whether they have admin rights where required.

## GitHub App settings

In your GitHub App configuration, set the setup URL to:

`https://YOUR_DIGITALOCEAN_DOMAIN/github-app/install/callback`

If the app may be reconfigured after it is already installed, also enable `Redirect on update`.

The desktop app starts users at:

`GET /auth/github/start?state=...&desktop_redirect_uri=...`

and starts installs at:

`GET /github-app/install/start?state=...&desktop_redirect_uri=...`

Both flows use signed broker-managed `state` values and only allow desktop redirect URIs that match
`ALLOWED_DESKTOP_CALLBACK_PREFIXES`.

## Authorization model

All `/api/...` routes now require a broker session bearer token.

The broker authorizes requests like this:

- user installations: the signed-in GitHub login must match the installation owner
- organization installations: the signed-in GitHub user must be an active member of the org
- mutating org actions: the signed-in GitHub user must be an org admin

Broker sessions are currently stored in memory. That is acceptable for this test app, but for
production you should move them to durable shared storage if you need restart resilience or
multi-instance scaling.

## DigitalOcean deployment

Deploy as a Node app and set the same environment variables in DigitalOcean App Platform.

Recommended notes:

- store `GITHUB_APP_PRIVATE_KEY`, `GITHUB_OAUTH_CLIENT_SECRET`, and `BROKER_STATE_SECRET` as encrypted
  runtime secrets
- `BROKER_TOKEN` is no longer the primary auth mechanism for desktop API access
- after changing env vars, redeploy the app
