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
});

const { buildGithubOauthStartUrl } = await import("./broker-auth.js");
const { decodeInstallState } = await import("./install-state.js");

test("GitHub OAuth start URL forwards select_account prompt", () => {
  const authUrl = new URL(buildGithubOauthStartUrl(
    {},
    "http://127.0.0.1:45873/broker/auth/callback",
    "desktop-state",
    { prompt: "select_account" },
  ));

  assert.equal(authUrl.origin + authUrl.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(authUrl.searchParams.get("prompt"), "select_account");

  const state = decodeInstallState(authUrl.searchParams.get("state"));
  assert.equal(state.desktopRedirectUri, "http://127.0.0.1:45873/broker/auth/callback");
  assert.equal(state.desktopState, "desktop-state");
});

test("GitHub OAuth start URL rejects unsupported prompt values", () => {
  assert.throws(
    () => buildGithubOauthStartUrl(
      {},
      "http://127.0.0.1:45873/broker/auth/callback",
      "desktop-state",
      { prompt: "none" },
    ),
    /Unsupported GitHub OAuth prompt/,
  );
});
