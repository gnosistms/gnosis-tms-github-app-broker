import express from "express";

import { ensureBrokerSession } from "./security.js";
import {
  createGnosisQaListRepo,
  listGnosisQaListsForInstallation,
  permanentlyDeleteGnosisQaListRepo,
} from "./qa-list-repos.js";
import { asyncJsonRoute, parseInstallationId } from "./route-helpers.js";

export function registerQaListRoutes(app) {
  app.get(
    "/api/github-app/installations/:installationId/gnosis-qa-lists",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const payload = await listGnosisQaListsForInstallation(
        parseInstallationId(request.params.installationId),
        request.brokerSession,
      );
      response.json(payload);
    }),
  );

  app.post(
    "/api/github-app/gnosis-qa-lists",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      const payload = await createGnosisQaListRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(201).json(payload);
    }),
  );

  app.delete(
    "/api/github-app/gnosis-qa-lists",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await permanentlyDeleteGnosisQaListRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );
}
