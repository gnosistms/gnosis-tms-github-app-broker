import {
  buildGithubOauthStartUrl,
  createBrokerSessionForGithubUser,
  decodeBrokerOauthState,
  exchangeGithubOauthCode,
  loadGithubUser,
  revokeBrokerSessionFromHeader,
  validateDesktopRedirectUri,
} from "./broker-auth.js";
import { ensureBrokerSession } from "./security.js";
import { listAuthorizedOrganizations } from "./authorization.js";
import { asyncJsonRoute, asyncTextRoute } from "./route-helpers.js";

export function registerAuthRoutes(app, { renderRedirectPage }) {
  app.get("/auth/github/start", asyncJsonRoute(async (request, response) => {
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
  }));

  app.get("/auth/github/callback", asyncTextRoute(async (request, response) => {
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
  }));

  app.get("/api/auth/session", ensureBrokerSession, (request, response) => {
    response.json({
      login: request.brokerSession.user.login,
      name: request.brokerSession.user.name || null,
      avatarUrl: request.brokerSession.user.avatarUrl || null,
    });
  });

  app.get("/api/auth/organizations", ensureBrokerSession, asyncJsonRoute(async (request, response) => {
    response.json(await listAuthorizedOrganizations(request.brokerSession));
  }));

  app.post("/api/auth/logout", ensureBrokerSession, (request, response) => {
    revokeBrokerSessionFromHeader(request);
    response.status(204).end();
  });
}
