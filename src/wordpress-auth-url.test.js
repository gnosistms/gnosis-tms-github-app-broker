import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .trim()
  .toString();

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "gnosis-tms",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: privateKeyPem,
  BROKER_STATE_SECRET: "broker-state-secret",
  WORDPRESS_CLIENT_ID: "wp-client-id",
  WORDPRESS_CLIENT_SECRET: "wp-client-secret",
});

const { config } = await import("./config.js");
const { buildWordpressOauthStartUrl } = await import("./wordpress-auth.js");
const { decodeInstallState } = await import("./install-state.js");

test("WordPress OAuth start URL targets the code flow with broker callback", () => {
  const authUrl = new URL(buildWordpressOauthStartUrl(
    "http://127.0.0.1:45873/wordpress/auth/callback",
    "desktop-state",
  ));

  assert.equal(
    authUrl.origin + authUrl.pathname,
    "https://public-api.wordpress.com/oauth2/authorize",
  );
  assert.equal(authUrl.searchParams.get("client_id"), "wp-client-id");
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.equal(
    authUrl.searchParams.get("redirect_uri"),
    "http://127.0.0.1:3000/auth/wordpress/callback",
  );
  // No scope parameter: the default token is scoped to the single authorized blog.
  assert.equal(authUrl.searchParams.get("scope"), null);

  const state = decodeInstallState(authUrl.searchParams.get("state"));
  assert.equal(state.desktopRedirectUri, "http://127.0.0.1:45873/wordpress/auth/callback");
  assert.equal(state.desktopState, "desktop-state");
});

test("WordPress OAuth start URL fails clearly when not configured", () => {
  const previousClientId = config.wordpressClientId;
  config.wordpressClientId = "";
  try {
    assert.throws(
      () => buildWordpressOauthStartUrl(
        "http://127.0.0.1:45873/wordpress/auth/callback",
        "desktop-state",
      ),
      /WordPress export is not configured/,
    );
  } finally {
    config.wordpressClientId = previousClientId;
  }
});
