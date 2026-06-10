import { ensureBrokerSession } from "./security.js";
import { listGnosisResourcesForInstallation } from "./installation-resources.js";
import { asyncJsonRoute, parseInstallationId } from "./route-helpers.js";

export function registerResourceRoutes(app) {
  app.get(
    "/api/github-app/installations/:installationId/gnosis-resources",
    ensureBrokerSession,
    asyncJsonRoute(async (request, response) => {
      const payload = await listGnosisResourcesForInstallation(
        parseInstallationId(request.params.installationId),
        request.brokerSession,
      );
      response.json(payload);
    }),
  );
}
