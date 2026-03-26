import express from "express";
import { pathToFileURL } from "node:url";

import { config } from "./config.js";
import {
  buildGithubOauthStartUrl,
  createBrokerSessionForGithubUser,
  decodeBrokerOauthState,
  exchangeGithubOauthCode,
  loadGithubUser,
  revokeBrokerSessionFromHeader,
  validateDesktopRedirectUri,
} from "./broker-auth.js";
import { getInstallation, listInstallationRepositories } from "./github-app.js";
import {
  createGnosisProjectRepo,
  ensureGnosisRepoPropertiesSchema,
  listGnosisProjectsForInstallation,
  markGnosisProjectRepoDeleted,
  permanentlyDeleteGnosisProjectRepo,
  renameGnosisProjectRepo,
  restoreGnosisProjectRepo,
} from "./project-repos.js";
import {
  ensureInstallationAccess,
  getInstallationAccessDetails,
  listAuthorizedOrganizations,
  listInstallationMembers,
} from "./authorization.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { ensureAllowedDesktopCallback, ensureBrokerSession } from "./security.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      app: "gnosis-tms-github-app-broker",
    });
  });

  app.get("/auth/github/start", (request, response) => {
    try {
      const desktopState = String(request.query.state || "").trim();
      const desktopRedirectUri = validateDesktopRedirectUri(
        String(request.query.desktop_redirect_uri || "").trim(),
      );

      if (!desktopState) {
        response.status(400).json({ error: "Missing state query parameter." });
        return;
      }

      renderRedirectPage(
        response,
        buildGithubOauthStartUrl(request, desktopRedirectUri, desktopState),
        "Redirecting To GitHub",
        "Gnosis TMS is opening GitHub so you can authorize the app and continue setup.",
        "Opening GitHub now...",
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/auth/github/callback", async (request, response) => {
    try {
      const code = String(request.query.code || "");
      const state = String(request.query.state || "");
      if (!code) {
        response.status(400).send("Missing code.");
        return;
      }

      const decodedState = decodeBrokerOauthState(state);
      const accessToken = await exchangeGithubOauthCode(request, code);
      const user = await loadGithubUser(accessToken);
      const sessionToken = createBrokerSessionForGithubUser(accessToken, user);

      const redirectUrl = new URL(decodedState.desktopRedirectUri);
      redirectUrl.searchParams.set("state", decodedState.desktopState);
      redirectUrl.searchParams.set("broker_session_token", sessionToken);
      redirectUrl.searchParams.set("login", user.login);
      if (user.name) {
        redirectUrl.searchParams.set("name", user.name);
      }
      if (user.avatarUrl) {
        redirectUrl.searchParams.set("avatar_url", user.avatarUrl);
      }

      renderRedirectPage(
        response,
        redirectUrl.toString(),
        "Returning To Gnosis TMS",
        "GitHub authorization is complete. Gnosis TMS is opening again so you can continue.",
        "Reopening Gnosis TMS...",
      );
    } catch (error) {
      response.status(400).send(error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/auth/session", ensureBrokerSession, async (request, response) => {
    response.json({
      login: request.brokerSession.user.login,
      name: request.brokerSession.user.name || null,
      avatarUrl: request.brokerSession.user.avatarUrl || null,
    });
  });

  app.get("/api/auth/organizations", ensureBrokerSession, async (request, response) => {
    try {
      response.json(await listAuthorizedOrganizations(request.brokerSession));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/logout", ensureBrokerSession, (request, response) => {
    revokeBrokerSessionFromHeader(request);
    response.status(204).end();
  });

  app.get("/github-app/install/start", (request, response) => {
    try {
      const userState = String(request.query.state || "").trim();
      const desktopRedirectUri = ensureAllowedDesktopCallback(
        String(request.query.desktop_redirect_uri || "").trim(),
      );

      if (!userState) {
        response.status(400).json({ error: "Missing state query parameter." });
        return;
      }

      const brokerState = encodeInstallState({
        userState,
        desktopRedirectUri,
        createdAt: new Date().toISOString(),
      });

      const installUrl = new URL(
        `https://github.com/apps/${config.githubAppSlug}/installations/new`,
      );
      installUrl.searchParams.set("state", brokerState);

      renderRedirectPage(
        response,
        installUrl.toString(),
        "Redirecting To GitHub",
        "Gnosis TMS is opening GitHub so you can install or configure the GitHub App for your organization.",
        "Opening GitHub now...",
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/github-app/install/callback", async (request, response) => {
    try {
      const installationId = Number.parseInt(String(request.query.installation_id || ""), 10);
      const state = String(request.query.state || "");
      const setupAction = String(request.query.setup_action || "");

      if (!Number.isFinite(installationId)) {
        response.status(400).send("Missing or invalid installation_id.");
        return;
      }

      const decodedState = decodeInstallState(state);
      const installation = await getInstallation(installationId);

      const redirectUrl = new URL(decodedState.desktopRedirectUri);
      redirectUrl.searchParams.set("installation_id", String(installationId));
      redirectUrl.searchParams.set("state", decodedState.userState);
      if (setupAction) {
        redirectUrl.searchParams.set("setup_action", setupAction);
      }

      renderRedirectPage(
        response,
        redirectUrl.toString(),
        "Returning To Gnosis TMS",
        "GitHub App setup is complete. Gnosis TMS is opening again so you can continue.",
        "Reopening Gnosis TMS...",
      );

      console.log(
        `Forwarded installation ${installation.installationId} for ${installation.accountLogin} to desktop callback.`,
      );
    } catch (error) {
      response.status(400).send(error instanceof Error ? error.message : String(error));
    }
  });

  app.get(
    "/api/github-app/installations/:installationId",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const installation = await getInstallationAccessDetails({
          installationId,
          brokerSession: request.brokerSession,
        });
        response.json(installation);
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get(
    "/api/github-app/installations/:installationId/repositories",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        await ensureInstallationAccess({
          installationId,
          brokerSession: request.brokerSession,
          requireAdmin: false,
        });
        const repositories = await listInstallationRepositories(installationId);
        response.json(repositories);
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get(
    "/api/github-app/installations/:installationId/members",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const orgLogin = String(request.query.org_login || "").trim();
        response.json(
          await listInstallationMembers(installationId, orgLogin, request.brokerSession),
        );
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch(
    "/api/github-app/installations/:installationId/orgs/:orgLogin",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const orgLogin = request.params.orgLogin;
        const name = String(request.body?.name || "").trim();
        await ensureInstallationAccess({
          installationId,
          brokerSession: request.brokerSession,
          requireAdmin: true,
        });
        const { githubApi } = await import("./github-app.js");
        const githubResponse = await githubApi(`/orgs/${orgLogin}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${request.brokerSession.accessToken}`,
          },
          body: JSON.stringify({ name }),
        });
        const payload = await githubResponse.json();
        response.json({
          login: payload.login,
          name: payload.name || null,
          description: payload.description || null,
          createdAt: payload.created_at || null,
          avatarUrl: payload.avatar_url || null,
          htmlUrl: payload.html_url || null,
        });
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/properties/schema",
    ensureBrokerSession,
    async (request, response) => {
      try {
        await ensureGnosisRepoPropertiesSchema({
          installationId: Number.parseInt(request.params.installationId, 10),
          orgLogin: request.params.orgLogin,
          brokerSession: request.brokerSession,
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.delete(
    "/api/github-app/installations/:installationId/orgs/:orgLogin",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const orgLogin = request.params.orgLogin;
        await ensureInstallationAccess({
          installationId,
          brokerSession: request.brokerSession,
          requireAdmin: true,
        });
        const { githubApi } = await import("./github-app.js");
        await githubApi(`/orgs/${orgLogin}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${request.brokerSession.accessToken}`,
          },
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.delete(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/membership",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const orgLogin = request.params.orgLogin;
        await ensureInstallationAccess({
          installationId,
          brokerSession: request.brokerSession,
          requireAdmin: false,
        });
        const { githubApi } = await import("./github-app.js");
        await githubApi(`/user/memberships/orgs/${orgLogin}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${request.brokerSession.accessToken}`,
          },
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get(
    "/api/github-app/installations/:installationId/gnosis-projects",
    ensureBrokerSession,
    async (request, response) => {
      try {
        const payload = await listGnosisProjectsForInstallation(
          Number.parseInt(request.params.installationId, 10),
          request.brokerSession,
        );
        response.json(payload);
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/github-app/gnosis-projects",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        const payload = await createGnosisProjectRepo({
          ...(request.body || {}),
          brokerSession: request.brokerSession,
        });
        response.status(201).json(payload);
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch(
    "/api/github-app/gnosis-projects/rename",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        await renameGnosisProjectRepo({
          ...(request.body || {}),
          brokerSession: request.brokerSession,
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch(
    "/api/github-app/gnosis-projects/delete-marker",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        await markGnosisProjectRepoDeleted({
          ...(request.body || {}),
          brokerSession: request.brokerSession,
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch(
    "/api/github-app/gnosis-projects/restore-marker",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        await restoreGnosisProjectRepo({
          ...(request.body || {}),
          brokerSession: request.brokerSession,
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.delete(
    "/api/github-app/gnosis-projects",
    ensureBrokerSession,
    express.json(),
    async (request, response) => {
      try {
        await permanentlyDeleteGnosisProjectRepo({
          ...(request.body || {}),
          brokerSession: request.brokerSession,
        });
        response.status(204).end();
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  return app;
}

function renderRedirectPage(response, targetUrl, title, message, statusText) {
  const safeTargetUrl = JSON.stringify(targetUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7ecd5;
        --panel: #fffaf4;
        --text: #3f2610;
        --muted: #9c6a33;
        --accent: #ec9827;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(236, 152, 39, 0.24), transparent 42%),
          linear-gradient(180deg, #f3d389 0%, var(--bg) 100%);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(100%, 760px);
        background: rgba(255, 250, 244, 0.96);
        border: 1px solid rgba(164, 112, 41, 0.14);
        border-radius: 28px;
        padding: 40px;
        box-shadow: 0 24px 60px rgba(131, 82, 22, 0.14);
      }

      .eyebrow {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.25rem, 5vw, 4rem);
        line-height: 0.95;
      }

      p {
        margin: 20px 0 0;
        font-size: 1.15rem;
        line-height: 1.65;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        margin-top: 28px;
        padding: 14px 18px;
        border-radius: 999px;
        background: rgba(236, 152, 39, 0.12);
        color: var(--muted);
        font-weight: 700;
      }

      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 0 0 rgba(236, 152, 39, 0.45);
        animation: pulse 1.4s infinite;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(236, 152, 39, 0.45); }
        70% { box-shadow: 0 0 0 14px rgba(236, 152, 39, 0); }
        100% { box-shadow: 0 0 0 0 rgba(236, 152, 39, 0); }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Gnosis TMS</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="status"><span class="dot"></span>${escapeHtml(statusText)}</div>
    </main>
    <script>
      window.setTimeout(() => {
        window.location.replace(${safeTargetUrl});
      }, 120);
    </script>
  </body>
</html>`;

  response.status(200).type("html").send(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`GitHub App broker listening on port ${config.port}`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer();
}
