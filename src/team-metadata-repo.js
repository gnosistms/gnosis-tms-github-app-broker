import { createInstallationAccessToken, githubApi } from "./github-app.js";

const TEAM_METADATA_REPO_NAME = "team-metadata";
const TEAM_METADATA_SCHEMA_VERSION = 1;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function listRepositoryDirectory(fullName, path, installationToken) {
  try {
    const response = await githubApi(`/repos/${fullName}/contents/${path}`, {
      headers: authHeaders(installationToken),
    });
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    if (error?.githubStatus === 404) {
      return [];
    }
    throw error;
  }
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

async function deleteRepositoryFile({
  fullName,
  path,
  message,
  installationToken,
  sha,
}) {
  await githubApi(`/repos/${fullName}/contents/${path}`, {
    method: "DELETE",
    headers: authHeaders(installationToken),
    body: JSON.stringify({
      message,
      sha,
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

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function normalizeStringList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeOptionalString(value))
      .filter(Boolean),
  )];
}

function normalizeLanguage(value, fallback = null) {
  const code = normalizeOptionalString(value?.code);
  const name = normalizeOptionalString(value?.name);
  if (!code || !name) {
    return fallback;
  }
  return { code, name };
}

function resourceRecordPath(kind, resourceId) {
  return `resources/${kind === "project" ? "projects" : "glossaries"}/${resourceId}.json`;
}

function resourceDirectoryPath(kind) {
  return `resources/${kind === "project" ? "projects" : "glossaries"}`;
}

async function loadTeamMetadataRepository({ installationId, orgLogin }) {
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

  return {
    installationToken,
    repository,
    manifest: manifest.value,
  };
}

function buildSharedMetadataRecord({
  kind,
  resourceId,
  input,
  existingValue = null,
  actorLogin = null,
}) {
  const now = new Date().toISOString();
  const current =
    existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
      ? existingValue
      : {};
  const currentRepoName = normalizeOptionalString(current.repoName);
  const nextRepoName = normalizeOptionalString(input.repoName) ?? currentRepoName;
  const title = normalizeOptionalString(input.title) ?? normalizeOptionalString(current.title);
  if (!nextRepoName) {
    throw new Error(`Could not determine the ${kind} repo name for team metadata.`);
  }
  if (!title) {
    throw new Error(`Could not determine the ${kind} title for team metadata.`);
  }

  const previousRepoNames = normalizeStringList([
    ...(Array.isArray(current.previousRepoNames) ? current.previousRepoNames : []),
    ...(Array.isArray(input.previousRepoNames) ? input.previousRepoNames : []),
    ...(currentRepoName && currentRepoName !== nextRepoName ? [currentRepoName] : []),
  ]).filter((repoName) => repoName !== nextRepoName);

  return {
    id: resourceId,
    kind,
    title,
    repoName: nextRepoName,
    previousRepoNames,
    githubRepoId:
      normalizeOptionalNumber(input.githubRepoId) ?? normalizeOptionalNumber(current.githubRepoId),
    githubNodeId:
      normalizeOptionalString(input.githubNodeId) ?? normalizeOptionalString(current.githubNodeId),
    fullName:
      normalizeOptionalString(input.fullName) ?? normalizeOptionalString(current.fullName),
    defaultBranch:
      normalizeOptionalString(input.defaultBranch)
      ?? normalizeOptionalString(current.defaultBranch)
      ?? "main",
    lifecycleState:
      normalizeOptionalString(input.lifecycleState)
      ?? normalizeOptionalString(current.lifecycleState)
      ?? "active",
    remoteState:
      normalizeOptionalString(input.remoteState)
      ?? normalizeOptionalString(current.remoteState)
      ?? "pendingCreate",
    recordState:
      normalizeOptionalString(input.recordState)
      ?? normalizeOptionalString(current.recordState)
      ?? "live",
    createdAt: normalizeOptionalString(current.createdAt) ?? now,
    updatedAt: now,
    deletedAt:
      Object.prototype.hasOwnProperty.call(input, "deletedAt")
        ? normalizeOptionalString(input.deletedAt)
        : normalizeOptionalString(current.deletedAt),
    createdBy: normalizeOptionalString(current.createdBy) ?? normalizeOptionalString(actorLogin),
    updatedBy: normalizeOptionalString(actorLogin) ?? normalizeOptionalString(current.updatedBy),
    deletedBy:
      Object.prototype.hasOwnProperty.call(input, "deletedBy")
        ? normalizeOptionalString(input.deletedBy)
        : normalizeOptionalString(current.deletedBy),
  };
}

function buildProjectMetadataRecord({ resourceId, input, existingValue, actorLogin }) {
  const shared = buildSharedMetadataRecord({
    kind: "project",
    resourceId,
    input,
    existingValue,
    actorLogin,
  });

  return {
    ...shared,
    chapterCount:
      Number.isFinite(input.chapterCount)
        ? Number(input.chapterCount)
        : Number.isFinite(existingValue?.chapterCount)
          ? Number(existingValue.chapterCount)
          : 0,
  };
}

function buildGlossaryMetadataRecord({ resourceId, input, existingValue, actorLogin }) {
  const shared = buildSharedMetadataRecord({
    kind: "glossary",
    resourceId,
    input,
    existingValue,
    actorLogin,
  });

  return {
    ...shared,
    sourceLanguage: normalizeLanguage(input.sourceLanguage, existingValue?.sourceLanguage ?? null),
    targetLanguage: normalizeLanguage(input.targetLanguage, existingValue?.targetLanguage ?? null),
    termCount:
      Number.isFinite(input.termCount)
        ? Number(input.termCount)
        : Number.isFinite(existingValue?.termCount)
          ? Number(existingValue.termCount)
          : 0,
  };
}

function normalizeSharedMetadataRecord(record, kind) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const id = normalizeOptionalString(record.id);
  const title = normalizeOptionalString(record.title);
  const repoName = normalizeOptionalString(record.repoName);
  if (!id || !title || !repoName) {
    return null;
  }

  return {
    id,
    kind,
    title,
    repoName,
    previousRepoNames: normalizeStringList(record.previousRepoNames),
    githubRepoId: normalizeOptionalNumber(record.githubRepoId),
    githubNodeId: normalizeOptionalString(record.githubNodeId),
    fullName: normalizeOptionalString(record.fullName),
    defaultBranch: normalizeOptionalString(record.defaultBranch) ?? "main",
    lifecycleState: normalizeOptionalString(record.lifecycleState) ?? "active",
    remoteState: normalizeOptionalString(record.remoteState) ?? "pendingCreate",
    recordState: normalizeOptionalString(record.recordState) ?? "live",
    createdAt: normalizeOptionalString(record.createdAt),
    updatedAt: normalizeOptionalString(record.updatedAt),
    deletedAt: normalizeOptionalString(record.deletedAt),
    createdBy: normalizeOptionalString(record.createdBy),
    updatedBy: normalizeOptionalString(record.updatedBy),
    deletedBy: normalizeOptionalString(record.deletedBy),
  };
}

function normalizeProjectMetadataRecord(record) {
  const shared = normalizeSharedMetadataRecord(record, "project");
  if (!shared) {
    return null;
  }

  return {
    ...shared,
    chapterCount: Number.isFinite(record.chapterCount) ? Number(record.chapterCount) : 0,
  };
}

function normalizeGlossaryMetadataRecord(record) {
  const shared = normalizeSharedMetadataRecord(record, "glossary");
  if (!shared) {
    return null;
  }

  return {
    ...shared,
    sourceLanguage: normalizeLanguage(record.sourceLanguage, null),
    targetLanguage: normalizeLanguage(record.targetLanguage, null),
    termCount: Number.isFinite(record.termCount) ? Number(record.termCount) : 0,
  };
}

async function listMetadataRecords({ installationId, orgLogin, kind, normalizeRecord }) {
  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const directoryEntries = await listRepositoryDirectory(
    repository.full_name,
    resourceDirectoryPath(kind),
    installationToken,
  );
  const jsonPaths = directoryEntries
    .filter((entry) =>
      entry?.type === "file"
      && typeof entry.path === "string"
      && entry.path.endsWith(".json")
    )
    .map((entry) => entry.path);

  const records = await Promise.all(
    jsonPaths.map(async (path) => {
      const file = await getRepositoryFileJsonWithSha(repository.full_name, path, installationToken);
      return normalizeRecord(file?.value);
    }),
  );

  return records.filter(Boolean);
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
  const { repository, manifest } = await loadTeamMetadataRepository({ installationId, orgLogin });
  return normalizeMetadataRepoPayload(repository, manifest);
}

export async function upsertProjectMetadataRecord({
  installationId,
  orgLogin,
  brokerSession,
  ...input
}) {
  const resourceId = normalizeOptionalString(input.projectId);
  if (!resourceId) {
    throw new Error("Could not determine which project metadata record to write.");
  }

  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const path = resourceRecordPath("project", resourceId);
  const existingRecord = await getRepositoryFileJsonWithSha(
    repository.full_name,
    path,
    installationToken,
  );
  const record = buildProjectMetadataRecord({
    resourceId,
    input,
    existingValue: existingRecord?.value || null,
    actorLogin: brokerSession?.user?.login ?? null,
  });

  await putRepositoryFile({
    fullName: repository.full_name,
    path,
    message: existingRecord ? "Update project metadata record" : "Create project metadata record",
    content: `${JSON.stringify(record, null, 2)}\n`,
    installationToken,
    sha: existingRecord?.sha || null,
  });
}

export async function deleteProjectMetadataRecord({
  installationId,
  orgLogin,
  projectId,
}) {
  const resourceId = normalizeOptionalString(projectId);
  if (!resourceId) {
    throw new Error("Could not determine which project metadata record to delete.");
  }

  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const path = resourceRecordPath("project", resourceId);
  const existingRecord = await getRepositoryFileJsonWithSha(
    repository.full_name,
    path,
    installationToken,
  );
  if (!existingRecord?.sha) {
    return;
  }

  await deleteRepositoryFile({
    fullName: repository.full_name,
    path,
    message: "Delete project metadata record",
    installationToken,
    sha: existingRecord.sha,
  });
}

export async function upsertGlossaryMetadataRecord({
  installationId,
  orgLogin,
  brokerSession,
  ...input
}) {
  const resourceId = normalizeOptionalString(input.glossaryId);
  if (!resourceId) {
    throw new Error("Could not determine which glossary metadata record to write.");
  }

  const { installationToken, repository } = await loadTeamMetadataRepository({
    installationId,
    orgLogin,
  });
  const path = resourceRecordPath("glossary", resourceId);
  const existingRecord = await getRepositoryFileJsonWithSha(
    repository.full_name,
    path,
    installationToken,
  );
  const record = buildGlossaryMetadataRecord({
    resourceId,
    input,
    existingValue: existingRecord?.value || null,
    actorLogin: brokerSession?.user?.login ?? null,
  });

  await putRepositoryFile({
    fullName: repository.full_name,
    path,
    message: existingRecord ? "Update glossary metadata record" : "Create glossary metadata record",
    content: `${JSON.stringify(record, null, 2)}\n`,
    installationToken,
    sha: existingRecord?.sha || null,
  });
}

export async function listProjectMetadataRecords({
  installationId,
  orgLogin,
}) {
  return listMetadataRecords({
    installationId,
    orgLogin,
    kind: "project",
    normalizeRecord: normalizeProjectMetadataRecord,
  });
}

export async function listGlossaryMetadataRecords({
  installationId,
  orgLogin,
}) {
  return listMetadataRecords({
    installationId,
    orgLogin,
    kind: "glossary",
    normalizeRecord: normalizeGlossaryMetadataRecord,
  });
}
