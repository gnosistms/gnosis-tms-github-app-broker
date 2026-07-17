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

const { listAccessibleInstallations } = await import("./authorization.js");
const { resetInstallationAccessCacheForTests } = await import("./installation-access.js");
const { githubApi, resetInstallationTokenCacheForTests } = await import("./github-app.js");

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

function githubResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function brokerSession() {
  return {
    accessToken: "caller-token",
    user: {
      login: "owner",
    },
  };
}

function installationSummary(id, orgLogin) {
  return {
    id,
    account: {
      login: orgLogin,
      id: id * 10,
      type: "Organization",
      avatar_url: `https://avatars.example/${orgLogin}`,
      html_url: `https://github.com/${orgLogin}`,
    },
    html_url: `https://github.com/organizations/${orgLogin}/settings/installations/${id}`,
    app_slug: "gnosis-tms",
    target_type: "Organization",
    permissions: { contents: "write" },
  };
}

// Fixture for the enrichment chain of a healthy installation plus one whose
// /orgs/<login> lookup fails with a non-retryable error.
function installListingFetchFixture({ failingOrg }) {
  const calls = [];
  globalThis.fetch = async (url, fetchOptions = {}) => {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const method = fetchOptions.method ?? "GET";
    calls.push({ path, method });

    if (method === "GET" && path === "/user/installations?per_page=100") {
      return githubResponse({
        installations: [
          installationSummary(42, "healthy-org"),
          installationSummary(77, failingOrg),
        ],
      });
    }

    const installationMatch = path.match(/^\/app\/installations\/(\d+)$/);
    if (method === "GET" && installationMatch) {
      const id = Number(installationMatch[1]);
      const orgLogin = id === 42 ? "healthy-org" : failingOrg;
      return githubResponse(installationSummary(id, orgLogin));
    }

    if (method === "GET" && path === `/orgs/${failingOrg}`) {
      return githubResponse({ message: "Bad credentials" }, 401);
    }

    if (method === "GET" && path.startsWith("/user/memberships/orgs/")) {
      return githubResponse({ state: "active", role: "admin" });
    }

    if (method === "GET" && path === "/orgs/healthy-org") {
      return githubResponse({ name: "Healthy Org", description: null });
    }

    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return githubResponse({ token: "installation-token" });
    }

    if (method === "GET" && /^\/orgs\/[^/]+\/teams\?per_page=100$/.test(path)) {
      return githubResponse([]);
    }

    // Everything else (team-metadata repo lookups etc.) is irrelevant to these
    // tests; a 404 short-circuits those chains without triggering the retry
    // path a thrown fixture error (treated as a network failure) would.
    return githubResponse({ message: "Not Found" }, 404);
  };
  return calls;
}

test.beforeEach(() => {
  resetInstallationAccessCacheForTests();
  resetInstallationTokenCacheForTests();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

test("a failed enrichment yields a degraded entry instead of dropping the installation", async () => {
  installListingFetchFixture({ failingOrg: "broken-org" });
  const loggedErrors = [];
  console.error = (message) => loggedErrors.push(String(message));

  const installations = await listAccessibleInstallations(brokerSession());

  assert.equal(installations.length, 2);

  const healthy = installations.find((entry) => entry.installationId === 42);
  assert.equal(healthy.accountLogin, "healthy-org");
  assert.equal(healthy.membershipRole, "owner");
  assert.equal(healthy.accessDetailsError, undefined);

  const degraded = installations.find((entry) => entry.installationId === 77);
  assert.equal(degraded.accountLogin, "broken-org");
  assert.equal(degraded.accountType, "Organization");
  assert.equal(degraded.membershipState, "unknown");
  assert.equal(degraded.membershipRole, null);
  assert.equal(degraded.canDelete, false);
  assert.equal(degraded.canManageMembers, false);
  assert.equal(degraded.canManageProjects, false);
  assert.match(degraded.accessDetailsError, /GitHub API 401/);

  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0], /77/);
  assert.match(loggedErrors[0], /broken-org/);
});

test("githubApi retries a GET on transient 5xx when retries are requested", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return githubResponse({ message: "Unicorn!" }, 503, { "retry-after": "0" });
    }
    return githubResponse({ ok: true });
  };

  const response = await githubApi("/user/installations?per_page=100", { retries: 2 });
  const payload = await response.json();

  assert.equal(attempts, 2);
  assert.equal(payload.ok, true);
});

test("githubApi does not retry by default", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return githubResponse({ message: "Unicorn!" }, 503);
  };

  await assert.rejects(githubApi("/orgs/some-org"), /GitHub API 503/);
  assert.equal(attempts, 1);
});

test("githubApi does not retry a POST on 5xx even when retries are requested", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return githubResponse({ message: "Unicorn!" }, 503);
  };

  await assert.rejects(
    githubApi("/app/installations/42/access_tokens", { method: "POST", retries: 2 }),
    /GitHub API 503/,
  );
  assert.equal(attempts, 1);
});

test("githubApi backs off between retries when Retry-After is absent", async () => {
  let attempts = 0;
  const startedAt = Date.now();
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      // No Retry-After header — the common brownout case must still back off
      // (a missing header parsed as Number(null) === 0 once meant zero delay).
      return githubResponse({ message: "Unicorn!" }, 503);
    }
    return githubResponse({ ok: true });
  };

  await githubApi("/user/installations?per_page=100", { retries: 2 });

  assert.equal(attempts, 2);
  assert.ok(Date.now() - startedAt >= 500, "expected at least the first backoff delay");
});

test("githubApi surfaces the original error after retries are exhausted", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return githubResponse({ message: "Unicorn!" }, 503, { "retry-after": "0" });
  };

  await assert.rejects(githubApi("/rate-limited", { retries: 2 }), (error) => {
    assert.equal(error.githubStatus, 503);
    return true;
  });
  assert.equal(attempts, 3);
});
