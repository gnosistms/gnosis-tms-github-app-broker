import { config } from "./config.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { ensureAllowedDesktopCallback } from "./security.js";

const WORDPRESS_AUTHORIZE_URL = "https://public-api.wordpress.com/oauth2/authorize";
const WORDPRESS_TOKEN_URL = "https://public-api.wordpress.com/oauth2/token";

export function isWordpressOauthConfigured() {
  return Boolean(config.wordpressClientId && config.wordpressClientSecret);
}

export function ensureWordpressOauthConfigured() {
  if (!isWordpressOauthConfigured()) {
    throw new Error(
      "WordPress export is not configured on this broker. Set WORDPRESS_CLIENT_ID and WORDPRESS_CLIENT_SECRET.",
    );
  }
}

function wordpressOauthCallbackUrl() {
  return new URL("/auth/wordpress/callback", config.publicBaseUrl).toString();
}

// No `scope` parameter: the default WordPress.com token is scoped to the single
// blog the user authorizes, which is all the desktop export needs.
export function buildWordpressOauthStartUrl(desktopRedirectUri, desktopState) {
  ensureWordpressOauthConfigured();

  const state = encodeInstallState({
    desktopRedirectUri,
    desktopState,
    createdAt: new Date().toISOString(),
  });

  const url = new URL(WORDPRESS_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.wordpressClientId);
  url.searchParams.set("redirect_uri", wordpressOauthCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeWordpressOauthCode(code) {
  ensureWordpressOauthConfigured();

  const response = await fetch(WORDPRESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "gnosis-tms-github-app-broker",
    },
    body: new URLSearchParams({
      client_id: config.wordpressClientId,
      client_secret: config.wordpressClientSecret,
      redirect_uri: wordpressOauthCallbackUrl(),
      grant_type: "authorization_code",
      code,
    }).toString(),
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description || payload.error || "WordPress.com OAuth exchange failed.",
    );
  }

  return {
    accessToken: payload.access_token,
    blogId: String(payload.blog_id ?? ""),
    blogUrl: String(payload.blog_url ?? ""),
  };
}

export function decodeWordpressOauthState(state) {
  return decodeInstallState(state);
}

export function validateWordpressDesktopRedirectUri(value) {
  return ensureAllowedDesktopCallback(value);
}
