import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const { privateKey: brokerPrivateKey, publicKey: brokerPublicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const brokerPrivateKeyPem = brokerPrivateKey
  .export({ type: "pkcs8", format: "pem" })
  .trim()
  .toString();
const brokerPublicKeyPem = brokerPublicKey
  .export({ type: "spki", format: "pem" })
  .trim()
  .toString();

Object.assign(process.env, {
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "gnosis-tms",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: brokerPrivateKeyPem,
  BROKER_STATE_SECRET: "broker-state-secret",
  TEAM_AI_BROKER_PRIVATE_KEY: brokerPrivateKeyPem,
  TEAM_AI_BROKER_PUBLIC_KEY: brokerPublicKeyPem,
});

const [
  { registerTeamAiRoutes },
  {
    TEAM_AI_WRAPPED_KEY_ALGORITHM,
    decryptWrappedKeyForBroker,
    encryptWrappedKeyForPublicKey,
  },
  {
    issueTeamAiProviderSecretForInstallation,
    saveTeamAiProviderSecretForInstallation,
    teamAiDependencies,
  },
  {
    putTeamAiSecretsRecord,
    teamAiMetadataDependencies,
  },
] = await Promise.all([
  import("./team-ai-routes.js"),
  import("./team-ai-crypto.js"),
  import("./team-ai.js"),
  import("./team-ai-metadata.js"),
]);

function replaceDependencies(target, overrides) {
  const original = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, target[key]]),
  );
  Object.assign(target, overrides);
  return () => {
    Object.assign(target, original);
  };
}

function jsonResponse(value) {
  return {
    async json() {
      return value;
    },
  };
}

function emptyProviders() {
  return {
    openai: null,
    gemini: null,
    claude: null,
    deepseek: null,
  };
}

test("registerTeamAiRoutes exposes the broker public key route", async () => {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ method: "GET", path, handlers });
    },
    put(path, ...handlers) {
      routes.push({ method: "PUT", path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: "POST", path, handlers });
    },
  };

  registerTeamAiRoutes(app);

  const route = routes.find(
    (entry) =>
      entry.method === "GET" && entry.path === "/api/team-ai/broker-public-key",
  );
  assert.ok(route, "expected the broker public key route to be registered");

  let statusCode = 200;
  let payload = null;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  await route.handlers.at(-1)({}, response);

  assert.equal(statusCode, 200);
  assert.equal(payload.algorithm, TEAM_AI_WRAPPED_KEY_ALGORITHM);
  assert.equal(payload.publicKeyPem, brokerPublicKeyPem);
});

test("putTeamAiSecretsRecord deletes ai/secrets.json when the last provider is cleared", async () => {
  const requests = [];
  const restore = replaceDependencies(teamAiMetadataDependencies, {
    now: () => "2026-04-16T12:00:00.000Z",
    createInstallationAccessToken: async () => "installation-token",
    githubApi: async (path, options = {}) => {
      requests.push({
        path,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (path === "/repos/team-one/team-metadata" && !options.method) {
        return jsonResponse({
          full_name: "team-one/team-metadata",
        });
      }

      if (path === "/repos/team-one/team-metadata/contents/ai/secrets.json" && !options.method) {
        return jsonResponse({
          encoding: "base64",
          sha: "sha-secrets-123",
          content: Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              updatedAt: "2026-04-15T00:00:00.000Z",
              updatedBy: "owner",
              providers: {
                openai: {
                  keyVersion: 3,
                  rotationReason: "manual",
                  brokerWrappedKey: {
                    algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
                    ciphertext: "ciphertext-previous",
                  },
                },
              },
            }),
            "utf8",
          ).toString("base64"),
        });
      }

      if (
        path === "/repos/team-one/team-metadata/contents/ai/secrets.json"
        && options.method === "DELETE"
      ) {
        return jsonResponse({});
      }

      throw new Error(`Unexpected githubApi call ${options.method || "GET"} ${path}`);
    },
  });

  try {
    const record = await putTeamAiSecretsRecord({
      installationId: 42,
      orgLogin: "team-one",
      actorLogin: "owner",
      record: {
        schemaVersion: 1,
        updatedAt: null,
        updatedBy: null,
        providers: emptyProviders(),
      },
    });

    assert.deepEqual(record, {
      schemaVersion: 1,
      updatedAt: null,
      updatedBy: null,
      providers: {},
    });

    const deleteRequest = requests.find((entry) => entry.method === "DELETE");
    assert.ok(deleteRequest, "expected the broker to delete ai/secrets.json");
    assert.equal(deleteRequest.path, "/repos/team-one/team-metadata/contents/ai/secrets.json");
    assert.deepEqual(deleteRequest.body, {
      message: "Clear team AI secrets",
      sha: "sha-secrets-123",
    });
    assert.equal(
      requests.some((entry) => entry.method === "PUT"),
      false,
      "expected no PUT after deleting the empty secrets file",
    );
  } finally {
    restore();
  }
});

test("saveTeamAiProviderSecretForInstallation saves and clears provider secrets", async (t) => {
  await t.test("save persists the wrapped key and increments the version", async () => {
    let persistedRecord = null;
    const restore = replaceDependencies(teamAiDependencies, {
      ensureInstallationAccess: async () => ({
        accountLogin: "team-one",
      }),
      getTeamAiSecretsRecord: async () => ({
        schemaVersion: 1,
        updatedAt: null,
        updatedBy: null,
        providers: emptyProviders(),
      }),
      normalizeWrappedKeyRecord: (wrappedKey) => wrappedKey,
      decryptWrappedKeyForBroker: (wrappedKey) => {
        assert.equal(wrappedKey.ciphertext, "ciphertext-new");
        return "sk-team-shared";
      },
      putTeamAiSecretsRecord: async ({ record }) => {
        persistedRecord = record;
        return {
          schemaVersion: 1,
          updatedAt: "2026-04-16T12:00:00.000Z",
          updatedBy: "owner",
          providers: record.providers,
        };
      },
    });

    try {
      const metadata = await saveTeamAiProviderSecretForInstallation({
        installationId: 42,
        orgLogin: "team-one",
        providerId: "openai",
        wrappedKey: {
          algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
          ciphertext: "ciphertext-new",
        },
        clear: false,
        brokerSession: {
          user: {
            login: "owner",
          },
        },
      });

      assert.equal(persistedRecord.providers.openai.keyVersion, 1);
      assert.deepEqual(persistedRecord.providers.openai.brokerWrappedKey, {
        algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
        ciphertext: "ciphertext-new",
      });
      assert.deepEqual(metadata, {
        schemaVersion: 1,
        updatedAt: "2026-04-16T12:00:00.000Z",
        updatedBy: "owner",
        providers: {
          openai: {
            configured: true,
            keyVersion: 1,
            algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
          },
        },
      });
    } finally {
      restore();
    }
  });

  await t.test("clear returns an empty providers map when the file is removed", async () => {
    let persistedRecord = null;
    const restore = replaceDependencies(teamAiDependencies, {
      ensureInstallationAccess: async () => ({
        accountLogin: "team-one",
      }),
      getTeamAiSecretsRecord: async () => ({
        schemaVersion: 1,
        updatedAt: "2026-04-15T00:00:00.000Z",
        updatedBy: "owner",
        providers: {
          ...emptyProviders(),
          openai: {
            keyVersion: 4,
            rotationReason: "manual",
            brokerWrappedKey: {
              algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
              ciphertext: "ciphertext-existing",
            },
          },
        },
      }),
      putTeamAiSecretsRecord: async ({ record }) => {
        persistedRecord = record;
        return {
          schemaVersion: 1,
          updatedAt: null,
          updatedBy: null,
          providers: {},
        };
      },
    });

    try {
      const metadata = await saveTeamAiProviderSecretForInstallation({
        installationId: 42,
        orgLogin: "team-one",
        providerId: "openai",
        wrappedKey: null,
        clear: true,
        brokerSession: {
          user: {
            login: "owner",
          },
        },
      });

      assert.equal(persistedRecord.providers.openai, null);
      assert.deepEqual(metadata, {
        schemaVersion: 1,
        updatedAt: null,
        updatedBy: null,
        providers: {},
      });
    } finally {
      restore();
    }
  });
});

test("issueTeamAiProviderSecretForInstallation permission checks allow active members and reject non-members", async (t) => {
  const baseDependencies = {
    getTeamAiSecretsRecord: async () => ({
      schemaVersion: 1,
      updatedAt: null,
      updatedBy: null,
      providers: {
        ...emptyProviders(),
        openai: {
          keyVersion: 7,
          rotationReason: "manual",
          brokerWrappedKey: {
            algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
            ciphertext: "ciphertext-canonical",
          },
        },
      },
    }),
    decryptWrappedKeyForBroker: (wrappedKey) => {
      assert.equal(wrappedKey.ciphertext, "ciphertext-canonical");
      return "sk-team-shared";
    },
    encryptWrappedKeyForPublicKey: (plaintext, memberPublicKeyPem) => ({
      algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
      ciphertext: `rewrapped:${plaintext}:${memberPublicKeyPem}`,
    }),
  };

  for (const accessCase of [
    { label: "owner", installation: { membershipState: "active", canDelete: true, canManageProjects: true } },
    { label: "admin", installation: { membershipState: "active", canDelete: false, canManageProjects: true } },
    { label: "member", installation: { membershipState: "active", canDelete: false, canManageProjects: false } },
  ]) {
    await t.test(`${accessCase.label} can issue a shared key`, async () => {
      const restore = replaceDependencies(teamAiDependencies, {
        ...baseDependencies,
        ensureInstallationAccess: async () => accessCase.installation,
      });

      try {
        const issued = await issueTeamAiProviderSecretForInstallation({
          installationId: 42,
          orgLogin: "team-one",
          providerId: "openai",
          memberPublicKeyPem: "member-public-key",
          brokerSession: {
            user: {
              login: "tester",
            },
          },
        });

        assert.deepEqual(issued, {
          providerId: "openai",
          keyVersion: 7,
          wrappedKey: {
            algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
            ciphertext: "rewrapped:sk-team-shared:member-public-key",
          },
        });
      } finally {
        restore();
      }
    });
  }

  await t.test("non-member is rejected", async () => {
    const restore = replaceDependencies(teamAiDependencies, {
      ...baseDependencies,
      ensureInstallationAccess: async () => {
        throw new Error("Your membership in @team-one is not active.");
      },
    });

    try {
      await assert.rejects(
        () =>
          issueTeamAiProviderSecretForInstallation({
            installationId: 42,
            orgLogin: "team-one",
            providerId: "openai",
            memberPublicKeyPem: "member-public-key",
            brokerSession: {
              user: {
                login: "tester",
              },
            },
          }),
        /not active/i,
      );
    } finally {
      restore();
    }
  });
});

test("team AI crypto supports wrap decrypt re-wrap round trips", () => {
  const { privateKey: memberPrivateKey, publicKey: memberPublicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const memberPrivateKeyPem = memberPrivateKey
    .export({ type: "pkcs8", format: "pem" })
    .trim()
    .toString();
  const memberPublicKeyPem = memberPublicKey
    .export({ type: "spki", format: "pem" })
    .trim()
    .toString();

  const brokerWrappedKey = encryptWrappedKeyForPublicKey(
    "sk-team-shared-roundtrip",
    brokerPublicKeyPem,
  );
  const plaintext = decryptWrappedKeyForBroker(brokerWrappedKey);

  assert.equal(plaintext, "sk-team-shared-roundtrip");

  const memberWrappedKey = encryptWrappedKeyForPublicKey(plaintext, memberPublicKeyPem);
  const memberPlaintext = crypto.privateDecrypt(
    {
      key: memberPrivateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(memberWrappedKey.ciphertext, "base64"),
  ).toString("utf8");

  assert.equal(memberPlaintext, "sk-team-shared-roundtrip");
});
