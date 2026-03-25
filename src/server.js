import express from "express";
import { pathToFileURL } from "node:url";

import { config } from "./config.js";
import { getInstallation, listInstallationRepositories } from "./github-app.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { ensureAllowedDesktopCallback, ensureBrokerToken } from "./security.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      app: "gnosis-tms-github-app-broker",
    });
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
    ensureBrokerToken,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const installation = await getInstallation(installationId);
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
    ensureBrokerToken,
    async (request, response) => {
      try {
        const installationId = Number.parseInt(request.params.installationId, 10);
        const repositories = await listInstallationRepositories(installationId);
        response.json(repositories);
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
