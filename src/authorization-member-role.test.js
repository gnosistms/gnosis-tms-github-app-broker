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
  listInstallationMembers,
  removeOrganizationMemberForInstallation,
  inviteUserToOrganizationForInstallation,
  setOrganizationMemberRoleForInstallation,
} = await import("./authorization.js");

const {
  getInstallationAccessDetails,
} = await import("./installation-access.js");

const {
  getInstallationGitTransportToken,
} = await import("./project-repos.js");

const originalFetch = globalThis.fetch;

function githubResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function githubContentResponse(value, sha = "content-sha") {
  return githubResponse({
    encoding: "base64",
    content: Buffer.from(`${JSON.stringify(value)}\n`, "utf8").toString("base64"),
    sha,
  });
}

function defaultBrokerSession() {
  return {
    accessToken: "caller-token",
    user: {
      login: "owner",
    },
  };
}

function installGithubFetchFixture(options = {}) {
  const calls = [];
  const callerRole = options.callerRole ?? "admin";
  const targetState = options.targetState ?? "active";
  const targetRole = options.targetRole ?? "member";
  const adminTeam = options.adminTeam ?? null;
  const adminTeamMembers = options.adminTeamMembers ?? [];
  const owners = options.owners ?? [{ login: "owner" }];
  const members = options.members ?? [{ login: "alice", avatar_url: null, html_url: null }];
  const existingViewerRecord = options.existingViewerRecord ?? null;
  let viewerMetadataDeleteFailuresRemaining = options.viewerMetadataDeleteFailures ?? 0;

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
      return githubResponse({ token: "installation-token" });
    }

    if (method === "GET" && path === "/orgs/team-one/teams?per_page=100") {
      return githubResponse(adminTeam ? [adminTeam] : []);
    }

    if (method === "GET" && path === "/orgs/team-one/teams/admins/members?per_page=100") {
      return githubResponse(adminTeamMembers);
    }

    if (method === "GET" && path === "/orgs/team-one/memberships/alice") {
      return githubResponse({
        state: targetState,
        role: targetRole,
      });
    }

    if (method === "GET" && path === "/users/alice") {
      return githubResponse({
        id: 1001,
        login: "alice",
        name: "Alice",
      });
    }

    if (method === "GET" && path === "/orgs/team-one/members?role=admin&per_page=100") {
      return githubResponse(owners);
    }

    if (method === "GET" && path === "/orgs/team-one/members?per_page=100") {
      return githubResponse(members);
    }

    if (method === "PUT" && path === "/orgs/team-one/memberships/alice") {
      return githubResponse({
        state: "active",
        role: JSON.parse(fetchOptions.body).role,
      });
    }

    if (method === "DELETE" && path === "/orgs/team-one/memberships/alice") {
      return githubResponse({});
    }

    if (method === "POST" && path === "/orgs/team-one/invitations") {
      return githubResponse({
        id: 77,
        login: "alice",
        email: null,
      }, 201);
    }

    if (method === "PUT" && path === "/orgs/team-one/teams/admins/memberships/alice") {
      return githubResponse({ role: "member" });
    }

    if (method === "DELETE" && path === "/orgs/team-one/teams/admins/memberships/alice") {
      return githubResponse({});
    }

    if (method === "GET" && path === "/repos/team-one/team-metadata") {
      return githubResponse({
        id: 900,
        name: "team-metadata",
        full_name: "team-one/team-metadata",
        html_url: "https://github.com/team-one/team-metadata",
        owner: { login: "team-one" },
      });
    }

    if (method === "GET" && path === "/repos/team-one/team-metadata/contents/manifest.json") {
      return githubContentResponse({
        schemaVersion: 1,
        teamId: "github-app-installation-42",
        installationId: 42,
        orgLogin: "team-one",
      });
    }

    if (method === "GET" && path === "/repos/team-one/team-metadata/contents/members") {
      return githubResponse(
        existingViewerRecord
          ? [{ type: "file", path: "members/alice.json" }]
          : [],
      );
    }

    if (method === "GET" && path === "/repos/team-one/team-metadata/contents/members/alice.json") {
      if (!existingViewerRecord) {
        return githubResponse({ message: "Not Found" }, 404);
      }
      return githubContentResponse(existingViewerRecord, "viewer-sha");
    }

    if (method === "PUT" && path === "/repos/team-one/team-metadata/contents/members/alice.json") {
      return githubResponse({ content: { path: "members/alice.json" } });
    }

    if (method === "DELETE" && path === "/repos/team-one/team-metadata/contents/members/alice.json") {
      if (viewerMetadataDeleteFailuresRemaining > 0) {
        viewerMetadataDeleteFailuresRemaining -= 1;
        return githubResponse({ message: "Server Error" }, 500);
      }
      return githubResponse({});
    }

    throw new Error(`Unexpected GitHub API call ${method} ${path}`);
  };

  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("setOrganizationMemberRoleForInstallation stores viewer role metadata", async () => {
  const calls = installGithubFetchFixture();

  await setOrganizationMemberRoleForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    role: "viewer",
    brokerSession: defaultBrokerSession(),
  });

  const metadataWrite = calls.find(
    (call) => call.method === "PUT" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json",
  );
  assert.ok(metadataWrite);
  const body = JSON.parse(metadataWrite.body);
  const record = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
  assert.equal(record.role, "viewer");
  assert.equal(record.normalizedUsername, "alice");
  assert.equal(calls.some((call) => call.method === "PUT" && call.path === "/orgs/team-one/memberships/alice"), false);
});

test("setOrganizationMemberRoleForInstallation clears viewer metadata when switching to translator", async () => {
  const calls = installGithubFetchFixture({
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  await setOrganizationMemberRoleForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    role: "translator",
    brokerSession: defaultBrokerSession(),
  });

  assert.equal(
    calls.some((call) => call.method === "DELETE" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json"),
    true,
  );
});

test("setOrganizationMemberRoleForInstallation promotes viewer to admin when metadata cleanup fails", async () => {
  const calls = installGithubFetchFixture({
    adminTeam: { slug: "admins" },
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
    viewerMetadataDeleteFailures: 3,
  });

  await setOrganizationMemberRoleForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    role: "admin",
    brokerSession: defaultBrokerSession(),
  });

  assert.equal(
    calls.some((call) => call.method === "PUT" && call.path === "/orgs/team-one/teams/admins/memberships/alice"),
    true,
  );
  assert.equal(
    calls.filter((call) => call.method === "DELETE" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json").length,
    3,
  );
});

test("setOrganizationMemberRoleForInstallation promotes viewer to owner when metadata cleanup fails", async () => {
  const calls = installGithubFetchFixture({
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
    viewerMetadataDeleteFailures: 3,
  });

  await setOrganizationMemberRoleForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    role: "owner",
    brokerSession: defaultBrokerSession(),
  });

  const promotionCall = calls.find(
    (call) => call.method === "PUT" && call.path === "/orgs/team-one/memberships/alice",
  );
  assert.ok(promotionCall);
  assert.deepEqual(JSON.parse(promotionCall.body), { role: "admin" });
  assert.equal(
    calls.filter((call) => call.method === "DELETE" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json").length,
    3,
  );
});

test("setOrganizationMemberRoleForInstallation demotes owners only with confirmation", async () => {
  const calls = installGithubFetchFixture({
    targetRole: "admin",
    owners: [{ login: "owner" }, { login: "alice" }],
  });

  await assert.rejects(
    setOrganizationMemberRoleForInstallation({
      installationId: 42,
      orgLogin: "team-one",
      username: "alice",
      role: "viewer",
      confirmationUsername: "wrong",
      brokerSession: defaultBrokerSession(),
    }),
    /Type @alice to change this Owner's role\./,
  );

  assert.equal(calls.some((call) => call.method === "PUT"), false);
});

test("setOrganizationMemberRoleForInstallation blocks last owner demotion", async () => {
  const calls = installGithubFetchFixture({
    targetRole: "admin",
    owners: [{ login: "alice" }],
  });

  await assert.rejects(
    setOrganizationMemberRoleForInstallation({
      installationId: 42,
      orgLogin: "team-one",
      username: "alice",
      role: "viewer",
      confirmationUsername: "alice",
      brokerSession: defaultBrokerSession(),
    }),
    /This team needs at least one Owner/,
  );

  assert.equal(calls.some((call) => call.method === "PUT"), false);
});

test("listInstallationMembers overlays viewer metadata after GitHub owner and app-admin checks", async () => {
  installGithubFetchFixture({
    adminTeam: { slug: "admins" },
    adminTeamMembers: [{ login: "bob" }, { login: "carol" }],
    owners: [{ login: "carol" }],
    members: [
      { login: "alice", avatar_url: null, html_url: null },
      { login: "bob", avatar_url: null, html_url: null },
      { login: "carol", avatar_url: null, html_url: null },
      { login: "dave", avatar_url: null, html_url: null },
    ],
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  const members = await listInstallationMembers(42, "team-one", defaultBrokerSession());

  assert.deepEqual(
    members.map((member) => [member.login, member.role]),
    [
      ["alice", "viewer"],
      ["bob", "admin"],
      ["carol", "owner"],
      ["dave", "translator"],
    ],
  );
});

test("listInstallationMembers treats stale viewer metadata as lower precedence than app admin", async () => {
  installGithubFetchFixture({
    adminTeam: { slug: "admins" },
    adminTeamMembers: [{ login: "alice" }],
    owners: [],
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  const members = await listInstallationMembers(42, "team-one", defaultBrokerSession());

  assert.deepEqual(
    members.map((member) => [member.login, member.role]),
    [["alice", "admin"]],
  );
});

test("inviteUserToOrganizationForInstallation includes the app admin team on admin invites", async () => {
  const calls = installGithubFetchFixture({
    adminTeam: { id: 321, slug: "admins" },
  });

  await inviteUserToOrganizationForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    inviteeId: null,
    inviteeLogin: "alice",
    inviteeEmail: null,
    role: "admin",
    brokerSession: defaultBrokerSession(),
  });

  const inviteRequest = calls.find(
    (call) => call.method === "POST" && call.path === "/orgs/team-one/invitations",
  );
  assert.deepEqual(JSON.parse(inviteRequest.body), {
    invitee_id: 1001,
    team_ids: [321],
    role: "direct_member",
  });
  assert.equal(
    calls.some((call) => call.method === "PUT" && call.path === "/orgs/team-one/teams/admins/memberships/alice"),
    false,
  );
  assert.equal(
    calls.some((call) => call.method === "PUT" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json"),
    false,
  );
});

test("inviteUserToOrganizationForInstallation requests GitHub owner role for owner invites", async () => {
  const calls = installGithubFetchFixture();

  await inviteUserToOrganizationForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    inviteeId: null,
    inviteeLogin: "alice",
    inviteeEmail: null,
    role: "owner",
    brokerSession: defaultBrokerSession(),
  });

  const inviteRequest = calls.find(
    (call) => call.method === "POST" && call.path === "/orgs/team-one/invitations",
  );
  assert.deepEqual(JSON.parse(inviteRequest.body), {
    invitee_id: 1001,
    role: "admin",
  });
});

test("removeOrganizationMemberForInstallation requires owner confirmation before removing another owner", async () => {
  const calls = installGithubFetchFixture({
    targetRole: "admin",
    owners: [{ login: "owner" }, { login: "alice" }],
  });

  await removeOrganizationMemberForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    username: "alice",
    confirmationUsername: "alice",
    brokerSession: defaultBrokerSession(),
  });

  assert.equal(
    calls.some((call) => call.method === "DELETE" && call.path === "/orgs/team-one/memberships/alice"),
    true,
  );
});

test("inviteUserToOrganizationForInstallation stores viewer metadata for viewer invites", async () => {
  const calls = installGithubFetchFixture();

  const invite = await inviteUserToOrganizationForInstallation({
    installationId: 42,
    orgLogin: "team-one",
    inviteeId: null,
    inviteeLogin: "alice",
    inviteeEmail: null,
    role: "viewer",
    brokerSession: defaultBrokerSession(),
  });

  assert.deepEqual(invite, {
    id: 77,
    login: "alice",
    email: null,
  });
  const metadataWrite = calls.find(
    (call) => call.method === "PUT" && call.path === "/repos/team-one/team-metadata/contents/members/alice.json",
  );
  assert.ok(metadataWrite);
  const inviteRequest = calls.find(
    (call) => call.method === "POST" && call.path === "/orgs/team-one/invitations",
  );
  assert.deepEqual(JSON.parse(inviteRequest.body), {
    invitee_id: 1001,
    role: "direct_member",
  });
});

test("getInstallationAccessDetails treats viewer metadata as read-only access", async () => {
  installGithubFetchFixture({
    callerRole: "member",
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  const details = await getInstallationAccessDetails({
    installationId: 42,
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "alice",
      },
    },
  });

  assert.equal(details.membershipState, "active");
  assert.equal(details.membershipRole, "viewer");
  assert.equal(details.canManageProjects, false);
  assert.equal(details.canManageMembers, false);
});

test("getInstallationAccessDetails returns translator for regular org members", async () => {
  installGithubFetchFixture({
    callerRole: "member",
  });

  const details = await getInstallationAccessDetails({
    installationId: 42,
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "alice",
      },
    },
  });

  assert.equal(details.membershipState, "active");
  assert.equal(details.membershipRole, "translator");
  assert.equal(details.canManageProjects, false);
  assert.equal(details.canManageMembers, false);
});

test("getInstallationAccessDetails treats stale viewer metadata as lower precedence than app admin", async () => {
  installGithubFetchFixture({
    callerRole: "member",
    adminTeam: { slug: "admins" },
    adminTeamMembers: [{ login: "alice" }],
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  const details = await getInstallationAccessDetails({
    installationId: 42,
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "alice",
      },
    },
  });

  assert.equal(details.membershipState, "active");
  assert.equal(details.membershipRole, "admin");
  assert.equal(details.canManageProjects, true);
  assert.equal(details.canManageMembers, false);
});

test("getInstallationGitTransportToken narrows viewer tokens to read-only repository permissions", async () => {
  const calls = installGithubFetchFixture({
    callerRole: "member",
    existingViewerRecord: {
      username: "alice",
      normalizedUsername: "alice",
      role: "viewer",
    },
  });

  const payload = await getInstallationGitTransportToken({
    installationId: 42,
    brokerSession: {
      accessToken: "caller-token",
      user: {
        login: "alice",
      },
    },
  });

  assert.deepEqual(payload, {
    token: "installation-token",
    readOnly: true,
  });
  const tokenRequests = calls.filter(
    (call) => call.method === "POST" && call.path === "/app/installations/42/access_tokens",
  );
  assert.ok(tokenRequests.length >= 2);
  assert.deepEqual(JSON.parse(tokenRequests.at(-1).body), {
    permissions: {
      contents: "read",
      metadata: "read",
    },
  });
});
