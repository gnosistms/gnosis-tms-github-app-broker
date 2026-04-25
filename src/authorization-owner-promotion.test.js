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

const { promoteOrganizationOwnerForInstallation } = await import("./authorization.js");

const originalFetch = globalThis.fetch;

function githubResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function installGithubFetchFixture(options = {}) {
  const calls = [];
  const callerRole = options.callerRole ?? "admin";
  const targetState = options.targetState ?? "active";
  const targetRole = options.targetRole ?? "member";

  globalThis.fetch = async (url, fetchOptions = {}) => {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const method = fetchOptions.method ?? "GET";
    calls.push({
      path,
      method,
      body: fetchOptions.body ?? "",
    });

    if (method === "GET" && path === "/app/installations/42") {
      return githubResponse({
        id: 42,
        account: {
          login: "team-one",
          id: 123,
          type: "Organization",
        },
        app_slug: "gnosis-tms",
        target_type: "Organization",
        permissions: {},
      });
    }

    if (method === "GET" && path === "/user/memberships/orgs/team-one") {
      return githubResponse({
        state: "active",
        role: callerRole,
      });
    }

    if (method === "GET" && path === "/orgs/team-one") {
      return githubResponse({
        name: "Team One",
        description: null,
      });
    }

    if (method === "POST" && path === "/app/installations/42/access_tokens") {
      return githubResponse({
        token: "installation-token",
      });
    }

    if (method === "GET" && path === "/orgs/team-one/teams?per_page=100") {
      return githubResponse([]);
    }

    if (method === "GET" && path === "/orgs/team-one/memberships/alice") {
      return githubResponse({
        state: targetState,
        role: targetRole,
      });
    }

    if (method === "PUT" && path === "/orgs/team-one/memberships/alice") {
      return githubResponse({
        state: "active",
        role: "admin",
      });
    }

    throw new Error(`Unexpected GitHub API call ${method} ${path}`);
  };

  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("promoteOrganizationOwnerForInstallation promotes an active member with the caller token", async () => {
  const calls = installGithubFetchFixture();

  await promoteOrganizationOwnerForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "owner",
      },
    },
  });

  const promotionCall = calls.find(
    (call) => call.method === "PUT" && call.path === "/orgs/team-one/memberships/alice",
  );
  assert.ok(promotionCall);
  assert.deepEqual(JSON.parse(promotionCall.body), { role: "admin" });
});

test("promoteOrganizationOwnerForInstallation rejects non-owner callers", async () => {
  const calls = installGithubFetchFixture({ callerRole: "member" });

  await assert.rejects(
    promoteOrganizationOwnerForInstallation({
      installationId: 42,
      orgLogin: "team-one",
      username: "alice",
      brokerSession: {
        accessToken: "caller-token",
        user: {
          login: "owner",
        },
      },
    }),
    /need admin access/i,
  );

  assert.equal(calls.some((call) => call.method === "PUT"), false);
});

test("promoteOrganizationOwnerForInstallation rejects inactive target memberships", async () => {
  const calls = installGithubFetchFixture({ targetState: "pending" });

  await assert.rejects(
    promoteOrganizationOwnerForInstallation({
      installationId: 42,
      orgLogin: "team-one",
      username: "alice",
      brokerSession: {
        accessToken: "caller-token",
        user: {
          login: "owner",
        },
      },
    }),
    /not an active member/i,
  );

  assert.equal(calls.some((call) => call.method === "PUT"), false);
});

test("promoteOrganizationOwnerForInstallation no-ops when target is already owner", async () => {
  const calls = installGithubFetchFixture({ targetRole: "admin" });

  await promoteOrganizationOwnerForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "owner",
      },
    },
  });

  assert.equal(calls.some((call) => call.method === "PUT"), false);
});
