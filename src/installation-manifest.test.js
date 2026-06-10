import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// config.js validates required env vars at import time, so set them (plus the webhook
// secret, which enables the manifest) before the dynamic imports.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "gnosis-tms",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
  BROKER_STATE_SECRET: "broker-state-secret",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
});

const {
  applyWebhookEventToManifest,
  getInstallationRepositoryContext,
  installationManifestEnabled,
  resetInstallationManifestsForTests,
} = await import("./installation-manifest.js");
const { registerWebhookRoutes, verifyWebhookSignature } = await import("./webhook-routes.js");

function fakeContext(label) {
  return {
    repositories: [{ full_name: `team/${label}` }],
    remoteHeadsByRepoKey: new Map([
      [`team/${label}`, { defaultBranchName: "main", defaultBranchHeadOid: `oid-${label}` }],
    ]),
    orgLogin: "team",
    orgPropertyMap: new Map(),
  };
}

test.afterEach(() => {
  resetInstallationManifestsForTests();
});

test("manifest caches the prelude context within the TTL and rebuilds after it", async () => {
  assert.equal(installationManifestEnabled(), true);
  let loads = 0;
  let clock = 1_000_000;
  const options = {
    loadContext: async () => {
      loads += 1;
      return fakeContext(`load-${loads}`);
    },
    now: () => clock,
  };

  const first = await getInstallationRepositoryContext(7, "token", options);
  const second = await getInstallationRepositoryContext(7, "token", options);
  assert.equal(loads, 1);
  assert.equal(second, first);

  clock += 11 * 60 * 1000;
  const third = await getInstallationRepositoryContext(7, "token", options);
  assert.equal(loads, 2);
  assert.notEqual(third, first);
});

test("push events update the cached head OID in place", async () => {
  let loads = 0;
  const options = {
    loadContext: async () => {
      loads += 1;
      return fakeContext("alpha");
    },
    now: () => 1_000_000,
  };
  const context = await getInstallationRepositoryContext(7, "token", options);

  const outcome = applyWebhookEventToManifest("push", {
    installation: { id: 7 },
    ref: "refs/heads/main",
    after: "new-head-oid",
    repository: { full_name: "Team/Alpha", default_branch: "main" },
  });

  assert.equal(outcome, "updated");
  assert.deepEqual(context.remoteHeadsByRepoKey.get("team/alpha"), {
    defaultBranchName: "main",
    defaultBranchHeadOid: "new-head-oid",
  });
  // Still cached — the push must not force a rebuild.
  await getInstallationRepositoryContext(7, "token", options);
  assert.equal(loads, 1);
});

test("non-default-branch pushes are ignored and repository events drop the manifest", async () => {
  let loads = 0;
  const options = {
    loadContext: async () => {
      loads += 1;
      return fakeContext("alpha");
    },
    now: () => 1_000_000,
  };
  await getInstallationRepositoryContext(7, "token", options);

  assert.equal(
    applyWebhookEventToManifest("push", {
      installation: { id: 7 },
      ref: "refs/heads/feature-branch",
      after: "oid",
      repository: { full_name: "team/alpha", default_branch: "main" },
    }),
    "ignored",
  );

  assert.equal(
    applyWebhookEventToManifest("repository", { installation: { id: 7 }, action: "renamed" }),
    "dropped",
  );
  await getInstallationRepositoryContext(7, "token", options);
  assert.equal(loads, 2);
});

test("webhook signature verification accepts only the matching HMAC", () => {
  const body = Buffer.from(JSON.stringify({ ok: true }));
  const signature = `sha256=${crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;

  assert.equal(verifyWebhookSignature("webhook-secret", body, signature), true);
  assert.equal(verifyWebhookSignature("webhook-secret", body, "sha256=deadbeef"), false);
  assert.equal(verifyWebhookSignature("webhook-secret", body, undefined), false);
  assert.equal(verifyWebhookSignature("", body, signature), false);
});

test("the webhook route verifies, parses, and applies events end to end", async () => {
  const routes = [];
  const app = {
    post(path, ...handlers) {
      routes.push({ path, handlers });
    },
  };
  registerWebhookRoutes(app);
  const route = routes.find((entry) => entry.path === "/webhooks/github");
  assert.ok(route, "webhook route registered");
  const handler = route.handlers.at(-1);

  // Seed a manifest so the push event has something to update.
  const options = {
    loadContext: async () => fakeContext("alpha"),
    now: () => 1_000_000,
  };
  const context = await getInstallationRepositoryContext(7, "token", options);

  const body = Buffer.from(JSON.stringify({
    installation: { id: 7 },
    ref: "refs/heads/main",
    after: "pushed-oid",
    repository: { full_name: "team/alpha", default_branch: "main" },
  }));
  const goodSignature = `sha256=${crypto.createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;

  function fakeResponse() {
    const result = { statusCode: null, ended: false, body: null };
    return {
      result,
      status(code) {
        result.statusCode = code;
        return this;
      },
      json(value) {
        result.body = value;
        result.ended = true;
      },
      end() {
        result.ended = true;
      },
    };
  }

  const ok = fakeResponse();
  handler(
    {
      body,
      get: (name) =>
        ({ "x-hub-signature-256": goodSignature, "x-github-event": "push" })[name.toLowerCase()],
    },
    ok,
  );
  assert.equal(ok.result.statusCode, 204);
  assert.equal(
    context.remoteHeadsByRepoKey.get("team/alpha").defaultBranchHeadOid,
    "pushed-oid",
  );

  const bad = fakeResponse();
  handler(
    {
      body,
      get: (name) =>
        ({ "x-hub-signature-256": "sha256=wrong", "x-github-event": "push" })[name.toLowerCase()],
    },
    bad,
  );
  assert.equal(bad.result.statusCode, 401);
});
