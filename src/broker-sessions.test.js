import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

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

const {
  createBrokerSession,
  getBrokerSession,
  getRefreshableBrokerSession,
} = await import("./broker-sessions.js");

function githubSessionPayload(overrides = {}) {
  return {
    accessToken: "github-access-token",
    refreshToken: "github-refresh-token",
    user: {
      login: "octocat",
    },
    ...overrides,
  };
}

test("getRefreshableBrokerSession accepts an expired broker session with a valid refresh token", () => {
  const token = createBrokerSession(githubSessionPayload(), {
    expiresAt: Date.now() - 1000,
  });

  assert.equal(getBrokerSession(token), null);
  assert.equal(getRefreshableBrokerSession(token)?.user.login, "octocat");
});

test("getRefreshableBrokerSession rejects sessions without a refresh token", () => {
  const token = createBrokerSession(
    githubSessionPayload({
      refreshToken: null,
    }),
    {
      expiresAt: Date.now() - 1000,
    },
  );

  assert.equal(getRefreshableBrokerSession(token), null);
});

test("getRefreshableBrokerSession rejects sessions with expired GitHub refresh tokens", () => {
  const token = createBrokerSession(
    githubSessionPayload({
      refreshTokenExpiresAt: Date.now() - 1000,
    }),
    {
      expiresAt: Date.now() - 1000,
    },
  );

  assert.equal(getRefreshableBrokerSession(token), null);
});
