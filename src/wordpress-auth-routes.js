import {
  buildWordpressOauthStartUrl,
  decodeWordpressOauthState,
  exchangeWordpressOauthCode,
  validateWordpressDesktopRedirectUri,
} from "./wordpress-auth.js";
import { asyncJsonRoute, asyncTextRoute } from "./route-helpers.js";

export function registerWordpressAuthRoutes(app, { renderRedirectPage }) {
  app.get("/auth/wordpress/start", asyncJsonRoute(async (request, response) => {
    const desktopState = String(request.query.state || "").trim();
    const desktopRedirectUri = validateWordpressDesktopRedirectUri(
      String(request.query.desktop_redirect_uri || "").trim(),
    );

    if (!desktopState) {
      response.status(400).json({ error: "Missing state query parameter." });
      return;
    }

    renderRedirectPage(
      response,
      buildWordpressOauthStartUrl(desktopRedirectUri, desktopState),
      "Redirecting To WordPress.com",
      "Gnosis TMS is opening WordPress.com so you can authorize the app and continue.",
      "Opening WordPress.com now...",
    );
  }));

  app.get("/auth/wordpress/callback", asyncTextRoute(async (request, response) => {
    const code = String(request.query.code || "");
    const state = String(request.query.state || "");
    if (!code) {
      response.status(400).send("Missing code.");
      return;
    }

    const decodedState = decodeWordpressOauthState(state);
    const connection = await exchangeWordpressOauthCode(code);

    const redirectUrl = new URL(decodedState.desktopRedirectUri);
    redirectUrl.searchParams.set("state", decodedState.desktopState);
    redirectUrl.searchParams.set("wp_access_token", connection.accessToken);
    redirectUrl.searchParams.set("blog_id", connection.blogId);
    redirectUrl.searchParams.set("blog_url", connection.blogUrl);

    renderRedirectPage(
      response,
      redirectUrl.toString(),
      "Returning To Gnosis TMS",
      "WordPress.com authorization is complete. Gnosis TMS is opening again so you can continue.",
      "Reopening Gnosis TMS...",
    );
  }));
}
