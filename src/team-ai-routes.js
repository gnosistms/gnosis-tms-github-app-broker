import express from "express";

import { ensureBrokerSession } from "./security.js";
import { asyncJsonRoute, parseInstallationId } from "./route-helpers.js";
import {
  getTeamAiBrokerPublicKey,
  issueTeamAiProviderSecretForInstallation,
  loadTeamAiSecretsMetadataForInstallation,
  loadTeamAiSettingsForInstallation,
  saveTeamAiProviderSecretForInstallation,
  saveTeamAiSettingsForInstallation,
} from "./team-ai.js";

export function registerTeamAiRoutes(app) {
  app.get(
    "/api/team-ai/broker-public-key",
    ensureBrokerSession,
    asyncJsonRoute(async (_request, response) => {
      response.json(getTeamAiBrokerPublicKey());
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-ai/settings",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      response.json(
        await loadTeamAiSettingsForInstallation({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.put(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-ai/settings",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      response.json(
        await saveTeamAiSettingsForInstallation({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          actionPreferences: request.body?.actionPreferences ?? null,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-ai/secrets",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      response.json(
        await loadTeamAiSecretsMetadataForInstallation({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.put(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-ai/providers/:providerId",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      response.json(
        await saveTeamAiProviderSecretForInstallation({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          providerId: request.params.providerId,
          wrappedKey: request.body?.wrappedKey ?? null,
          clear: request.body?.clear === true,
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );

  app.post(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/team-ai/providers/:providerId/issue",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      response.json(
        await issueTeamAiProviderSecretForInstallation({
          installationId: parseInstallationId(request.params.installationId),
          orgLogin: request.params.orgLogin,
          providerId: request.params.providerId,
          memberPublicKeyPem: request.body?.memberPublicKeyPem ?? "",
          brokerSession: request.brokerSession,
        }),
      );
    }),
  );
}
