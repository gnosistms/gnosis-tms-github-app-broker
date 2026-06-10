import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// config.js validates required env vars at import time, so set them before the
// dynamic import (same pattern as team-ai.test.js).
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

const { computeResourceListingDigest } = await import("./installation-resources.js");

function listing(overrides = {}) {
  return {
    projects: [
      { projectId: "p-1", fullName: "team/alpha", defaultBranchHeadOid: "oid-a" },
      { projectId: "p-2", fullName: "team/beta", defaultBranchHeadOid: "oid-b" },
    ],
    glossaries: [
      { glossaryId: "g-1", fullName: "team/glossary", defaultBranchHeadOid: "oid-g" },
    ],
    qaLists: [
      { qaListId: "q-1", fullName: "team/qa", defaultBranchHeadOid: "oid-q" },
    ],
    ...overrides,
  };
}

test("digest is deterministic and order-insensitive", () => {
  const base = listing();
  const reordered = listing({
    projects: [base.projects[1], base.projects[0]],
  });

  assert.equal(
    computeResourceListingDigest(base),
    computeResourceListingDigest(reordered),
  );
});

test("digest changes when a head OID moves", () => {
  const base = listing();
  const moved = listing({
    projects: [
      { ...base.projects[0], defaultBranchHeadOid: "oid-a-next" },
      base.projects[1],
    ],
  });

  assert.notEqual(
    computeResourceListingDigest(base),
    computeResourceListingDigest(moved),
  );
});

test("digest changes when a resource appears in any list", () => {
  const base = listing();
  const withNewQaList = listing({
    qaLists: [
      ...base.qaLists,
      { qaListId: "q-2", fullName: "team/qa-two", defaultBranchHeadOid: "oid-q2" },
    ],
  });

  assert.notEqual(
    computeResourceListingDigest(base),
    computeResourceListingDigest(withNewQaList),
  );
});

// Execute the shared listing helpers with realistic data. The listing path has no
// endpoint-level tests, so without these a missing transitive helper in
// installation-repos.js (a ReferenceError at runtime) would reach production unseen —
// which is exactly what happened with propertyRepositoryKey.
const {
  buildOrgPropertyMap,
  deriveOrgLoginFromRepositories,
  chunk,
  normalizeRepositoryKey,
} = await import("./installation-repos.js");

test("buildOrgPropertyMap keys entries from snake_case and owner/name fields", () => {
  const map = buildOrgPropertyMap([
    {
      repository_full_name: "Team/Repo-One",
      properties: [{ property_name: "gnosis-type", value: "project" }],
    },
    {
      repository_owner: "team",
      repository_name: "repo-two",
      property_values: [{ property_name: "gnosis-type", value: "glossary" }],
    },
    { not: "a repository entry" },
  ]);

  assert.deepEqual(map.get("team/repo-one"), [
    { property_name: "gnosis-type", value: "project" },
  ]);
  assert.deepEqual(map.get("team/repo-two"), [
    { property_name: "gnosis-type", value: "glossary" },
  ]);
  assert.equal(map.size, 2);
});

test("deriveOrgLoginFromRepositories falls back from owner login to full_name", () => {
  assert.equal(
    deriveOrgLoginFromRepositories([{ owner: { login: " team " } }]),
    "team",
  );
  assert.equal(
    deriveOrgLoginFromRepositories([{ full_name: "team/repo" }]),
    "team",
  );
  assert.equal(deriveOrgLoginFromRepositories([]), null);
});

test("chunk and normalizeRepositoryKey behave as the listings expect", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(normalizeRepositoryKey(" Team/Repo "), "team/repo");
});
