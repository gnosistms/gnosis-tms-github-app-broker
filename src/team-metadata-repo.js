import { createInstallationAccessToken, githubApi } from "./github-app.js";

const TEAM_METADATA_REPO_NAME = "team-metadata";
const TEAM_METADATA_SCHEMA_VERSION = 1;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function createOrLoadTeamMetadataRepository(orgLogin, installationToken) {
  try {
    const createResponse = await githubApi(`/orgs/${orgLogin}/repos`, {
      method: "POST",
      headers: authHeaders(installationToken),
      body: JSON.stringify({
        name: TEAM_METADATA_REPO_NAME,
        private: true,
        description: "Gnosis TMS team metadata",
      }),
    });
    return createResponse.json();
  } catch (error) {
    if (error?.githubStatus !== 422) {
      throw error;
    }
    const existingResponse = await githubApi(`/repos/${orgLogin}/${TEAM_METADATA_REPO_NAME}`, {
      headers: authHeaders(installationToken),
    });
    return existingResponse.json();
  }
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

async function ensureRepositoryFile({
  fullName,
  path,
  message,
  content,
  installationToken,
}) {
  const existing = await getRepositoryFileJsonWithSha(fullName, path, installationToken);
  if (existing) {
    return;
  }
  await putRepositoryFile({
    fullName,
    path,
    message,
    content,
    installationToken,
  });
}

function buildManifest({ installationId, orgLogin, existingValue = null }) {
  const now = new Date().toISOString();
  const current = existingValue && typeof existingValue === "object" ? existingValue : {};

  return {
    schemaVersion:
      Number.isInteger(current.schemaVersion) && current.schemaVersion > 0
        ? current.schemaVersion
        : TEAM_METADATA_SCHEMA_VERSION,
    teamId:
      typeof current.teamId === "string" && current.teamId.trim()
        ? current.teamId.trim()
        : `github-app-installation-${installationId}`,
    installationId,
    orgLogin,
    createdAt:
      typeof current.createdAt === "string" && current.createdAt.trim()
        ? current.createdAt.trim()
        : now,
    updatedAt: now,
  };
}

function normalizeMetadataRepoPayload(repository, manifest) {
  return {
    repoId: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    htmlUrl: repository.html_url || null,
    schemaVersion:
      Number.isInteger(manifest?.schemaVersion) && manifest.schemaVersion > 0
        ? manifest.schemaVersion
        : TEAM_METADATA_SCHEMA_VERSION,
    teamId:
      typeof manifest?.teamId === "string" && manifest.teamId.trim()
        ? manifest.teamId.trim()
        : "",
    installationId:
      Number.isInteger(manifest?.installationId)
        ? manifest.installationId
        : Number(repository?.id || 0),
    orgLogin:
      typeof manifest?.orgLogin === "string" && manifest.orgLogin.trim()
        ? manifest.orgLogin.trim()
        : repository.owner?.login || "",
    createdAt:
      typeof manifest?.createdAt === "string" && manifest.createdAt.trim()
        ? manifest.createdAt.trim()
        : null,
    updatedAt:
      typeof manifest?.updatedAt === "string" && manifest.updatedAt.trim()
        ? manifest.updatedAt.trim()
        : null,
  };
}

export async function ensureTeamMetadataRepo({ installationId, orgLogin }) {
  const installationToken = await createInstallationAccessToken(installationId);
  const repository = await createOrLoadTeamMetadataRepository(orgLogin, installationToken);
  const existingManifest = await getRepositoryFileJsonWithSha(
    repository.full_name,
    "manifest.json",
    installationToken,
  );
  const manifest = buildManifest({
    installationId,
    orgLogin,
    existingValue: existingManifest?.value || null,
  });

  await putRepositoryFile({
    fullName: repository.full_name,
    path: "manifest.json",
    message: existingManifest ? "Update team metadata manifest" : "Initialize team metadata manifest",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    installationToken,
    sha: existingManifest?.sha || null,
  });
  await ensureRepositoryFile({
    fullName: repository.full_name,
    path: "resources/projects/.gitkeep",
    message: "Initialize projects metadata folder",
    content: "",
    installationToken,
  });
  await ensureRepositoryFile({
    fullName: repository.full_name,
    path: "resources/glossaries/.gitkeep",
    message: "Initialize glossaries metadata folder",
    content: "",
    installationToken,
  });
  await ensureRepositoryFile({
    fullName: repository.full_name,
    path: "indexes/.gitkeep",
    message: "Initialize metadata indexes folder",
    content: "",
    installationToken,
  });

  return normalizeMetadataRepoPayload(repository, manifest);
}

export async function inspectTeamMetadataRepo({ installationId, orgLogin }) {
  const installationToken = await createInstallationAccessToken(installationId);
  const repositoryResponse = await githubApi(`/repos/${orgLogin}/${TEAM_METADATA_REPO_NAME}`, {
    headers: authHeaders(installationToken),
  });
  const repository = await repositoryResponse.json();
  const manifest = await getRepositoryFileJsonWithSha(
    repository.full_name,
    "manifest.json",
    installationToken,
  );

  if (!manifest?.value || typeof manifest.value !== "object") {
    throw new Error(`team-metadata manifest is missing or invalid for ${repository.full_name}.`);
  }

  return normalizeMetadataRepoPayload(repository, manifest.value);
}
