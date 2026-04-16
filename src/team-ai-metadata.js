import { createInstallationAccessToken, githubApi } from "./github-app.js";

const TEAM_METADATA_REPO_NAME = "team-metadata";
const TEAM_AI_SCHEMA_VERSION = 1;
const TEAM_AI_SETTINGS_PATH = "ai/settings.json";
const TEAM_AI_SECRETS_PATH = "ai/secrets.json";
const TEAM_AI_PROVIDER_IDS = ["openai", "gemini", "claude", "deepseek"];

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function teamAiRepositoryPath(orgLogin) {
  return `/repos/${orgLogin}/${TEAM_METADATA_REPO_NAME}`;
}

async function getRepositoryFileJsonWithSha(fullName, path, installationToken) {
  try {
    const response = await githubApi(`/repos/${fullName}/contents/${path}`, {
      headers: authHeaders(installationToken),
    });
    const payload = await response.json();
    if (payload.encoding !== "base64") {
      throw new Error(`Unexpected ${path} encoding for ${fullName}: ${payload.encoding}`);
    }

    const decoded = Buffer.from(String(payload.content || "").replace(/\n/g, ""), "base64")
      .toString("utf8");
    return {
      value: JSON.parse(decoded),
      sha: payload.sha,
    };
  } catch (error) {
    if (error?.githubStatus === 404) {
      return null;
    }
    throw error;
  }
}

async function putRepositoryFile({
  fullName,
  path,
  message,
  content,
  installationToken,
  sha = null,
}) {
  await githubApi(`/repos/${fullName}/contents/${path}`, {
    method: "PUT",
    headers: authHeaders(installationToken),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
}

async function loadTeamMetadataRepository({ installationId, orgLogin }) {
  const installationToken = await createInstallationAccessToken(installationId);
  const repositoryResponse = await githubApi(teamAiRepositoryPath(orgLogin), {
    headers: authHeaders(installationToken),
  });
  const repository = await repositoryResponse.json();
  return {
    installationToken,
    repository,
  };
}

function normalizeActionPreferences(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : null;
}

function normalizeWrappedKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const algorithm = normalizeOptionalString(value.algorithm);
  const ciphertext = normalizeOptionalString(value.ciphertext);
  if (!algorithm || !ciphertext) {
    return null;
  }

  return {
    algorithm,
    ciphertext,
  };
}

function normalizeSecretsProviders(value) {
  const providers = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    TEAM_AI_PROVIDER_IDS.map((providerId) => {
      const entry = providers[providerId];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [providerId, null];
      }

      const keyVersion = Number.isInteger(entry.keyVersion) && entry.keyVersion > 0
        ? entry.keyVersion
        : 1;
      const wrappedKey = normalizeWrappedKey(entry.brokerWrappedKey);
      if (!wrappedKey) {
        return [providerId, null];
      }

      return [providerId, {
        keyVersion,
        rotationReason: normalizeOptionalString(entry.rotationReason) ?? "manual",
        brokerWrappedKey: wrappedKey,
      }];
    }),
  );
}

function normalizeTeamAiSettingsRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return {
    schemaVersion:
      Number.isInteger(value.schemaVersion) && value.schemaVersion > 0
        ? value.schemaVersion
        : TEAM_AI_SCHEMA_VERSION,
    updatedAt: normalizeOptionalString(value.updatedAt),
    updatedBy: normalizeOptionalString(value.updatedBy),
    actionPreferences: normalizeActionPreferences(value.actionPreferences),
  };
}

function normalizeTeamAiSecretsRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schemaVersion: TEAM_AI_SCHEMA_VERSION,
      updatedAt: null,
      updatedBy: null,
      providers: Object.fromEntries(TEAM_AI_PROVIDER_IDS.map((providerId) => [providerId, null])),
    };
  }

  return {
    schemaVersion:
      Number.isInteger(value.schemaVersion) && value.schemaVersion > 0
        ? value.schemaVersion
        : TEAM_AI_SCHEMA_VERSION,
    updatedAt: normalizeOptionalString(value.updatedAt),
    updatedBy: normalizeOptionalString(value.updatedBy),
    providers: normalizeSecretsProviders(value.providers),
  };
}

export async function getTeamAiSettingsRecord({ installationId, orgLogin }) {
  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const existing = await getRepositoryFileJsonWithSha(
    repository.full_name,
    TEAM_AI_SETTINGS_PATH,
    installationToken,
  );
  return normalizeTeamAiSettingsRecord(existing?.value ?? null);
}

export async function putTeamAiSettingsRecord({
  installationId,
  orgLogin,
  actionPreferences,
  actorLogin = null,
}) {
  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const existing = await getRepositoryFileJsonWithSha(
    repository.full_name,
    TEAM_AI_SETTINGS_PATH,
    installationToken,
  );
  const current = normalizeTeamAiSettingsRecord(existing?.value ?? null);
  const record = {
    schemaVersion: TEAM_AI_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizeOptionalString(actorLogin),
    actionPreferences: normalizeActionPreferences(actionPreferences) ?? current?.actionPreferences,
  };

  await putRepositoryFile({
    fullName: repository.full_name,
    path: TEAM_AI_SETTINGS_PATH,
    message: existing ? "Update team AI settings" : "Create team AI settings",
    content: `${JSON.stringify(record, null, 2)}\n`,
    installationToken,
    sha: existing?.sha || null,
  });

  return record;
}

export async function getTeamAiSecretsRecord({ installationId, orgLogin }) {
  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const existing = await getRepositoryFileJsonWithSha(
    repository.full_name,
    TEAM_AI_SECRETS_PATH,
    installationToken,
  );
  return normalizeTeamAiSecretsRecord(existing?.value ?? null);
}

export async function putTeamAiSecretsRecord({
  installationId,
  orgLogin,
  record,
  actorLogin = null,
}) {
  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const existing = await getRepositoryFileJsonWithSha(
    repository.full_name,
    TEAM_AI_SECRETS_PATH,
    installationToken,
  );
  const normalizedRecord = normalizeTeamAiSecretsRecord(record);
  const nextRecord = {
    ...normalizedRecord,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizeOptionalString(actorLogin),
  };

  await putRepositoryFile({
    fullName: repository.full_name,
    path: TEAM_AI_SECRETS_PATH,
    message: existing ? "Update team AI secrets" : "Create team AI secrets",
    content: `${JSON.stringify(nextRecord, null, 2)}\n`,
    installationToken,
    sha: existing?.sha || null,
  });

  return nextRecord;
}
