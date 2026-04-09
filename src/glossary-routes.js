import express from "express";

import { ensureBrokerSession } from "./security.js";
import {
  createGnosisGlossaryRepo,
  listGnosisGlossariesForInstallation,
  permanentlyDeleteGnosisGlossaryRepo,
  upsertGnosisGlossaryMetadataRecord,
} from "./glossary-repos.js";
import { asyncJsonRoute, parseInstallationId } from "./route-helpers.js";

export function registerGlossaryRoutes(app) {
  app.get(
    "/api/github-app/installations/:installationId/gnosis-glossaries",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const payload = await listGnosisGlossariesForInstallation(
        parseInstallationId(request.params.installationId),
        request.brokerSession,
      );
      response.json(payload);
    }),
  );

  app.post(
    "/api/github-app/gnosis-glossaries",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      const payload = await createGnosisGlossaryRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(201).json(payload);
    }),
  );

  app.patch(
    "/api/github-app/gnosis-glossaries/metadata-record",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await upsertGnosisGlossaryMetadataRecord({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );

  app.delete(
    "/api/github-app/gnosis-glossaries",
    ensureBrokerSession,
    express.json(),
    asyncJsonRoute(async (request, response) => {
      await permanentlyDeleteGnosisGlossaryRepo({
        ...(request.body || {}),
        brokerSession: request.brokerSession,
      });
      response.status(204).end();
    }),
  );
}
