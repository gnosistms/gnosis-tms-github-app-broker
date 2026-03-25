# Gnosis TMS GitHub App Broker

Small Node/Express broker for GitHub App installation and installation-token-backed API calls.

This service sits between the Tauri desktop app and GitHub:

- the desktop app opens this broker in the browser
- the broker sends the user to the GitHub App install page
- GitHub redirects back to the broker setup URL
- the broker forwards the install result to the desktop callback URL
- the desktop app calls this broker for installation details and repository lists

## Required environment variables

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
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

## GitHub App settings

In your GitHub App configuration, set the setup URL to:

`https://YOUR_DIGITALOCEAN_DOMAIN/github-app/install/callback`

This broker starts users at:

`GET /github-app/install/start?state=...&desktop_redirect_uri=...`

and forwards them through GitHub with a signed broker-managed `state`.

## DigitalOcean deployment

Deploy as a Node app and set the same environment variables in DigitalOcean App Platform.

If you want the Tauri app to authenticate to broker API routes, set `BROKER_TOKEN` in DigitalOcean and the matching `GITHUB_APP_BROKER_TOKEN` in the Tauri app.
