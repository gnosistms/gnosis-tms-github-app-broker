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
} from "./project-repos.js";
import {
  ensureInstallationAccess,
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

      response.redirect(302, buildGithubOauthStartUrl(request, desktopRedirectUri, desktopState));
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/debug/oauth/start", (request, response) => {
    try {
      const desktopState = String(request.query.state || "debug-state").trim() || "debug-state";
      const desktopRedirectUri = validateDesktopRedirectUri(
        String(request.query.desktop_redirect_uri || "http://127.0.0.1:45873/broker/auth/callback").trim(),
      );

      response.json({
        oauthStartUrl: buildGithubOauthStartUrl(request, desktopRedirectUri, desktopState),
        desktopRedirectUri,
      });
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

      response.redirect(302, redirectUrl.toString());
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

      response.redirect(302, installUrl.toString());
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

      response.redirect(302, redirectUrl.toString());

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
        const installation = await ensureInstallationAccess({
          installationId,
          brokerSession: request.brokerSession,
          requireAdmin: false,
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
        const { createInstallationAccessToken, githubApi } = await import("./github-app.js");
        const installationToken = await createInstallationAccessToken(installationId);
        const githubResponse = await githubApi(`/orgs/${orgLogin}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${installationToken}`,
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

export function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`GitHub App broker listening on port ${config.port}`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer();
}
