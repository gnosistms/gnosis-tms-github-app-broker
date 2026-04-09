import express from "express";

import { config } from "./config.js";
import { ensureAllowedDesktopCallback, ensureBrokerSession } from "./security.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { createInstallationAccessToken, getInstallation, githubApi, listInstallationRepositories } from "./github-app.js";
import { ensureInstallationAccess, getInstallationAccessDetails } from "./installation-access.js";
import {
  addOrganizationAdminForInstallation,
  configureOrganizationForGnosis,
  inspectTeamMetadataForOrganization,
  inviteUserToOrganizationForInstallation,
  listAccessibleInstallations,
  listInstallationMembers,
  removeOrganizationAdminForInstallation,
  searchGithubUsersForInstallation,
} from "./authorization.js";
import { asyncJsonRoute, asyncTextRoute, parseInstallationId } from "./route-helpers.js";

export function registerInstallRoutes(app, { renderRedirectPage }) {
  app.get("/api/github-app/installations", ensureBrokerSession, asyncJsonRoute(async (request, response) => {
    response.json(await listAccessibleInstallations(request.brokerSession));
  }));

  app.get("/github-app/install/start", asyncJsonRoute(async (request, response) => {
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
  }));

  app.get("/github-app/install/callback", asyncTextRoute(async (request, response) => {
    const installationId = parseInstallationId(String(request.query.installation_id || ""));
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
  }));

  app.get(
    "/api/github-app/installations/:installationId",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const installation = await getInstallationAccessDetails({
        installationId,
        brokerSession: request.brokerSession,
      });
      response.json(installation);
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/repositories",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      await ensureInstallationAccess({
        installationId,
        brokerSession: request.brokerSession,
        requireAdmin: false,
      });
      response.json(await listInstallationRepositories(installationId));
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/members",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const orgLogin = String(request.query.org_login || "").trim();
      response.json(
        await listInstallationMembers(installationId, orgLogin, request.brokerSession),
      );
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/user-search",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const query = String(request.query.q || "").trim();
      response.json(
        await searchGithubUsersForInstallation(installationId, query, request.brokerSession),
      );
    }),
  );

  app.patch(
    "/api/github-app/installations/:installationId/orgs/:orgLogin",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const orgLogin = request.params.orgLogin;
      const name = String(request.body?.name || "").trim();
      const hasDescription = Object.prototype.hasOwnProperty.call(request.body || {}, "description");
      const description = hasDescription
        ? request.body?.description == null
          ? null
          : String(request.body.description)
        : undefined;
      await ensureInstallationAccess({
        installationId,
        brokerSession: request.brokerSession,
        requireAdmin: true,
      });
      const githubResponse = await githubApi(`/orgs/${orgLogin}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${request.brokerSession.accessToken}`,
        },
        body: JSON.stringify({
          ...(name ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        }),
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
    }),
  );

  app.post(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/setup",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      await configureOrganizationForGnosis({
        installationId: parseInstallationId(request.params.installationId),
        orgLogin: request.params.orgLogin,
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-metadata",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      response.json(
        await inspectTeamMetadataForOrganization({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.post(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/invitations",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const orgLogin = request.params.orgLogin;
      response.status(201).json(
        await inviteUserToOrganizationForInstallation({
          installationId,
          orgLogin,
          inviteeId:
            request.body?.inviteeId == null ? null : parseInstallationId(String(request.body.inviteeId)),
          inviteeLogin: request.body?.inviteeLogin ?? null,
          inviteeEmail: request.body?.inviteeEmail ?? null,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.delete(
    "/api/github-app/installations/:installationId/orgs/:orgLogin",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const orgLogin = request.params.orgLogin;
      await ensureInstallationAccess({
        installationId,
        brokerSession: request.brokerSession,
        requireAdmin: true,
      });
      await githubApi(`/orgs/${orgLogin}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${request.brokerSession.accessToken}`,
        },
      });
      response.status(204).end();
    }),
  );

  app.delete(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/membership",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const installationId = parseInstallationId(request.params.installationId);
      const orgLogin = request.params.orgLogin;
      await ensureInstallationAccess({
        installationId,
        brokerSession: request.brokerSession,
        requireAdmin: false,
      });
      const installationToken = await createInstallationAccessToken(installationId);
      await githubApi(`/orgs/${orgLogin}/memberships/${request.brokerSession.user.login}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${installationToken}`,
        },
      });
      response.status(204).end();
    }),
  );

  app.patch(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/admins/:username",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      await addOrganizationAdminForInstallation({
        installationId: parseInstallationId(request.params.installationId),
        orgLogin: request.params.orgLogin,
        username: request.params.username,
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.delete(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/admins/:username",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      await removeOrganizationAdminForInstallation({
        installationId: parseInstallationId(request.params.installationId),
        orgLogin: request.params.orgLogin,
        username: request.params.username,
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );
}
