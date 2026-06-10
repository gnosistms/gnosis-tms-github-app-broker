import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// config.js validates required env vars at import time; set them before importing.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "gnosis-tms",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
  BROKER_STATE_SECRET: "broker-state-secret",
});

const {
  clearInstallationTokenCache,
  createInstallationAccessToken,
  resetInstallationTokenCacheForTests,
} = await import("./github-app.js");

const realFetch = globalThis.fetch;
let fetchCalls = [];

function installTokenFetchStub({ expiresInMs = 60 * 60 * 1000 } = {}) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method ?? "GET" });
    return new Response(
      JSON.stringify({
        token: `token-${fetchCalls.length}`,
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetInstallationTokenCacheForTests();
});

test("installation tokens are reused until near expiry", async () => {
  installTokenFetchStub();

  const first = await createInstallationAccessToken(7);
  const second = await createInstallationAccessToken(7);
  assert.equal(first, "token-1");
  assert.equal(second, "token-1");
  assert.equal(fetchCalls.length, 1);
});

test("installation tokens are not reused across permission variants", async () => {
  installTokenFetchStub();

  const full = await createInstallationAccessToken(7);
  const readOnly = await createInstallationAccessToken(7, {
    permissions: { contents: "read", metadata: "read" },
  });
  assert.notEqual(full, readOnly);
  assert.equal(fetchCalls.length, 2);

  // Same variant again: served from cache.
  await createInstallationAccessToken(7, {
    permissions: { metadata: "read", contents: "read" },
  });
  assert.equal(fetchCalls.length, 2);
});

test("tokens already inside the refresh margin are not reused", async () => {
  installTokenFetchStub({ expiresInMs: 60 * 1000 });

  await createInstallationAccessToken(7);
  await createInstallationAccessToken(7);
  assert.equal(fetchCalls.length, 2);
});

test("clearInstallationTokenCache drops only that installation", async () => {
  installTokenFetchStub();

  await createInstallationAccessToken(7);
  await createInstallationAccessToken(8);
  clearInstallationTokenCache(7);
  await createInstallationAccessToken(7);
  await createInstallationAccessToken(8);
  assert.equal(fetchCalls.length, 3);
});
