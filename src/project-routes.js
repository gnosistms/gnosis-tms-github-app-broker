import express from "express";

import { ensureBrokerSession } from "./security.js";
import {
  createGnosisProjectRepo,
  ensureGnosisRepoPropertiesSchema,
  getInstallationGitTransportToken,
  listGnosisProjectsForInstallation,
  markGnosisProjectRepoDeleted,
  permanentlyDeleteGnosisProjectRepo,
  renameGnosisProjectRepo,
  restoreGnosisProjectRepo,
} from "./project-repos.js";
import { asyncJsonRoute, parseInstallationId } from "./route-helpers.js";

export function registerProjectRoutes(app) {
  app.patch(
    "/api/github-app/installations/:installationId/orgs/:orgLogin/properties/schema",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      await ensureGnosisRepoPropertiesSchema({
        installationId: parseInstallationId(request.params.installationId),
        orgLogin: request.params.orgLogin,
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/gnosis-projects",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const payload = await listGnosisProjectsForInstallation(
        parseInstallationId(request.params.installationId),
        request.brokerSession,
      );
      response.json(payload);
    }),
  );

  app.get(
    "/api/github-app/installations/:installationId/git-transport-token",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const payload = await getInstallationGitTransportToken({
        installationId: parseInstallationId(request.params.installationId),
        brokerSession: request.brokerSession,
      });
      response.json(payload);
    }),
  );

  app.post(
    "/api/github-app/gnosis-projects",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      const payload = await createGnosisProjectRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(201).json(payload);
    }),
  );

  app.patch(
    "/api/github-app/gnosis-projects/rename",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await renameGnosisProjectRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.patch(
    "/api/github-app/gnosis-projects/delete-marker",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await markGnosisProjectRepoDeleted({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.patch(
    "/api/github-app/gnosis-projects/restore-marker",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await restoreGnosisProjectRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.delete(
    "/api/github-app/gnosis-projects",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await permanentlyDeleteGnosisProjectRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );
}
