import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "gnosis-tms",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  BROKER_STATE_SECRET: "broker-state-secret",
  GNOSIS_ADMIN_TEAM_SLUG: "admins",
});

const {
  createGnosisProjectRepo,
  ensureGnosisRepoPropertiesSchema,
  permanentlyDeleteGnosisProjectRepo,
} = await import("./project-repos.js");
const { createGnosisGlossaryRepo } = await import("./glossary-repos.js");
const { createGnosisQaListRepo } = await import("./qa-list-repos.js");
const {
  getInstallationAccessDetails,
  resetInstallationAccessCacheForTests,
} = await import("./installation-access.js");
const { resetInstallationTokenCacheForTests } = await import("./github-app.js");

const originalFetch = globalThis.fetch;
const input = {
  installationId: 42,
  orgLogin: "team-one",
  repoName: "new-resource",
  projectTitle: "New project",
  projectId: "project-123",
  brokerSession: { accessToken: "caller-token", user: { login: "alice" } },
};
const repository = {
  id: 123,
  node_id: "R_123",
  name: input.repoName,
  full_name: `${input.orgLogin}/${input.repoName}`,
  html_url: `https://github.com/${input.orgLogin}/${input.repoName}`,
  private: true,
  default_branch: "main",
};

function githubResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function contentResponse(value) {
  return githubResponse({
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value)).toString("base64"),
    sha: "content-sha",
  });
}

function installGithubFixture({ role, membershipState = "active", schemaStatus = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method, body });

    if (method === "GET") {
      switch (path) {
        case "/app/installations/42":
          return githubResponse({ id: 42, account: { login: "team-one", type: "Organization" } });
        case "/user/memberships/orgs/team-one":
          // GitHub's organization "admin" is a Gnosis Owner. A Gnosis Admin
          // is an ordinary organization member in the configured admins team.
          return githubResponse({ state: membershipState, role: role === "owner" ? "admin" : "member" });
        case "/orgs/team-one":
          return githubResponse({ name: "Team One" });
        case "/orgs/team-one/teams?per_page=100":
          return githubResponse([{ slug: "admins" }]);
        case "/orgs/team-one/teams/admins/members?per_page=100":
          return githubResponse(role === "admin" ? [{ login: "alice" }] : []);
        case "/repos/team-one/team-metadata":
          return githubResponse({ full_name: "team-one/team-metadata" });
        case "/repos/team-one/team-metadata/contents/manifest.json":
          return contentResponse({ schemaVersion: 1, installationId: 42, orgLogin: "team-one" });
        case "/repos/team-one/team-metadata/contents/members":
          return githubResponse(role === "viewer" ? [{ type: "file", path: "members/alice.json" }] : []);
        case "/repos/team-one/team-metadata/contents/members/alice.json":
          return contentResponse({ username: "alice", role: "viewer" });
      }
    }
    if (method === "POST" && path === "/app/installations/42/access_tokens") {
      return githubResponse({ token: "installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    if (method === "PATCH" && path === "/orgs/team-one/properties/schema") {
      return githubResponse(schemaStatus === 200 ? {} : { message: "Schema permission denied" }, schemaStatus);
    }
    if (method === "POST" && path === "/orgs/team-one/repos") {
      return githubResponse(repository, 201);
    }
    if (method === "PATCH" && path === `/repos/${repository.full_name}/properties/values`) {
      return githubResponse({});
    }
    if (method === "PUT" && ["project.json", ".gitattributes"].some(
      (file) => path === `/repos/${repository.full_name}/contents/${file}`,
    )) {
      return githubResponse({});
    }
    if (method === "DELETE" && path === `/repos/${repository.full_name}`) {
      return githubResponse({});
    }
    throw new Error(`Unexpected GitHub API call ${method} ${path}`);
  };
  return calls;
}

function resourceWrites(calls) {
  return calls.filter((call) => call.method !== "GET" && !call.path.endsWith("/access_tokens"));
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetInstallationAccessCacheForTests();
  resetInstallationTokenCacheForTests();
});

for (const [kind, create] of [
  ["project", createGnosisProjectRepo],
  ["glossary", createGnosisGlossaryRepo],
  ["qa_list", createGnosisQaListRepo],
]) {
  for (const role of ["admin", "owner"]) {
    test(`${kind} creation succeeds for ${role} with the existing response contract`, async () => {
      const calls = installGithubFixture({ role });
      const result = await create(input);
      assert.deepEqual(result, {
        repoId: repository.id,
        nodeId: repository.node_id,
        name: repository.name,
        fullName: repository.full_name,
        htmlUrl: repository.html_url,
        private: true,
        description: null,
        defaultBranchName: "main",
        defaultBranchHeadOid: null,
        ...(kind === "project" ? { id: input.projectId, title: input.projectTitle, status: "active" } : {}),
      });
      const writes = resourceWrites(calls);
      assert.deepEqual(writes.slice(0, 3).map(({ method, path }) => [method, path]), [
        ["PATCH", "/orgs/team-one/properties/schema"],
        ["POST", "/orgs/team-one/repos"],
        ["PATCH", `/repos/${repository.full_name}/properties/values`],
      ]);
      assert.deepEqual(writes[1].body, { name: input.repoName, private: true });
      assert.deepEqual(writes[2].body, {
        properties: [{ property_name: "gnosis_tms_repo_type", value: kind }],
      });
      if (kind === "project") {
        assert.deepEqual(writes.slice(3).map(({ path }) => path), [
          `/repos/${repository.full_name}/contents/project.json`,
          `/repos/${repository.full_name}/contents/.gitattributes`,
        ]);
        assert.deepEqual(JSON.parse(Buffer.from(writes[3].body.content, "base64").toString()), {
          project_id: input.projectId,
          title: input.projectTitle,
          lifecycle: { state: "active" },
          chapter_order: [],
          deleted_chapter_order: [],
        });
        assert.equal(Buffer.from(writes[4].body.content, "base64").toString(), "*.json text eol=lf\nassets/** binary\n");
      } else {
        assert.equal(writes.length, 3);
      }
    });
  }

  for (const role of ["translator", "viewer"]) {
    test(`${kind} creation rejects ${role} before any resource writes`, async () => {
      const calls = installGithubFixture({ role });
      assert.equal((await getInstallationAccessDetails(input)).membershipRole, role);
      await assert.rejects(create(input), /do not have project admin access/);
      assert.deepEqual(resourceWrites(calls), []);
    });
  }

  test(`${kind} creation rejects inactive admin membership`, async () => {
    const calls = installGithubFixture({ role: "admin", membershipState: "pending" });
    await assert.rejects(create(input), /membership .* is not active/);
    assert.deepEqual(resourceWrites(calls), []);
  });

  test(`${kind} creation surfaces missing GitHub schema permissions before creating a repo`, async () => {
    const calls = installGithubFixture({ role: "admin", schemaStatus: 403 });
    await assert.rejects(create(input), /Custom properties: Admin/);
    assert.deepEqual(resourceWrites(calls).map(({ method, path }) => [method, path]), [
      ["PATCH", "/orgs/team-one/properties/schema"],
    ]);
  });
}

for (const [label, action, method, path] of [
  ["explicit schema setup", ensureGnosisRepoPropertiesSchema, "PATCH", "/orgs/team-one/properties/schema"],
  ["permanent project deletion", permanentlyDeleteGnosisProjectRepo, "DELETE", `/repos/${repository.full_name}`],
]) {
  test(`${label} remains denied to non-owner admins`, async () => {
    const calls = installGithubFixture({ role: "admin" });
    await assert.rejects(action(input), /need admin access/);
    assert.deepEqual(resourceWrites(calls), []);
  });

  test(`${label} remains allowed for owners`, async () => {
    const calls = installGithubFixture({ role: "owner" });
    await action(input);
    assert.deepEqual(resourceWrites(calls).map((call) => [call.method, call.path]), [[method, path]]);
  });
}
