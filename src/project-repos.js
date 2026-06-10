import {
  GNOSIS_TMS_REPO_STATUS_ACTIVE,
  GNOSIS_TMS_REPO_STATUS_DELETED,
} from "./constants.js";
import {
  ensureInstallationAccess,
  isReadOnlyInstallationAccess,
} from "./installation-access.js";
import {
  createInstallationAccessToken,
  githubApi,
} from "./github-app.js";
import {
  assignInitialProjectProperties,
  deleteRepository,
  ensureRepositoryPropertiesSchema,
  isProjectRepository,
} from "./repo-properties.js";
import {
  initializeProjectMetadata,
  loadProjectIdentity,
  renameProjectMetadata,
  updateProjectLifecycle,
} from "./project-metadata.js";
import {
  deleteProjectMetadataRecord as deleteProjectTeamMetadataRecord,
  listProjectMetadataRecords as listProjectTeamMetadataRecords,
  upsertProjectMetadataRecord as upsertProjectTeamMetadataRecord,
} from "./team-metadata-repo.js";
import {
  authHeaders,
  loadInstallationRepositoryContext,
  normalizeRepositoryKey,
} from "./installation-repos.js";

const PROJECT_METADATA_CONCURRENCY = 10;
const PROJECT_LISTING_CACHE = new Map();

function repoCacheKey(fullName) {
  return normalizeRepositoryKey(fullName);
}

function getInstallationProjectCache(installationId) {
  const cacheKey = String(installationId);
  if (!PROJECT_LISTING_CACHE.has(cacheKey)) {
    PROJECT_LISTING_CACHE.set(cacheKey, new Map());
  }
  return PROJECT_LISTING_CACHE.get(cacheKey);
}

function pruneInstallationProjectCache(installationId, repositories) {
  const cache = getInstallationProjectCache(installationId);
  const liveKeys = new Set(repositories.map((repository) => repoCacheKey(repository.full_name)));
  for (const key of cache.keys()) {
    if (!liveKeys.has(key)) {
      cache.delete(key);
    }
  }
  return cache;
}

function loadCachedProjectMetadata(cache, fullName, remoteHeadOid) {
  const entry = cache.get(repoCacheKey(fullName));
  const metadata = entry?.projectMetadata;
  if (!metadata) {
    return null;
  }

  const expectedHead = typeof remoteHeadOid === "string" && remoteHeadOid.trim()
    ? remoteHeadOid.trim()
    : null;
  const cachedHead = typeof metadata.remoteHeadOid === "string" && metadata.remoteHeadOid.trim()
    ? metadata.remoteHeadOid.trim()
    : null;

  if (cachedHead !== expectedHead) {
    return null;
  }

  if (
    typeof metadata.projectId !== "string" ||
    !metadata.projectId.trim() ||
    typeof metadata.title !== "string" ||
    !metadata.title.trim()
  ) {
    return null;
  }

  return {
    projectId: metadata.projectId,
    title: metadata.title,
    status:
      metadata.status === GNOSIS_TMS_REPO_STATUS_DELETED
        ? GNOSIS_TMS_REPO_STATUS_DELETED
        : GNOSIS_TMS_REPO_STATUS_ACTIVE,
  };
}

function saveCachedProjectMetadata(cache, fullName, remoteHeadOid, projectIdentity) {
  if (!projectIdentity?.projectId || !projectIdentity?.title) {
    return;
  }

  const key = repoCacheKey(fullName);
  const entry = cache.get(key) || {};
  cache.set(key, {
    ...entry,
    projectMetadata: {
      projectId: projectIdentity.projectId,
      title: projectIdentity.title,
      status:
        projectIdentity.status === GNOSIS_TMS_REPO_STATUS_DELETED
          ? GNOSIS_TMS_REPO_STATUS_DELETED
          : GNOSIS_TMS_REPO_STATUS_ACTIVE,
      remoteHeadOid:
        typeof remoteHeadOid === "string" && remoteHeadOid.trim() ? remoteHeadOid.trim() : null,
    },
  });
}

function propertyRepositoryKey(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const fullName =
    typeof entry.repository_full_name === "string" && entry.repository_full_name.trim()
      ? entry.repository_full_name.trim()
      : typeof entry.repositoryFullName === "string" && entry.repositoryFullName.trim()
        ? entry.repositoryFullName.trim()
        : null;
  if (fullName) {
    return repoCacheKey(fullName);
  }

  const owner =
    typeof entry.repository_owner === "string" && entry.repository_owner.trim()
      ? entry.repository_owner.trim()
      : typeof entry.repositoryOwner === "string" && entry.repositoryOwner.trim()
        ? entry.repositoryOwner.trim()
        : null;
  const name =
    typeof entry.repository_name === "string" && entry.repository_name.trim()
      ? entry.repository_name.trim()
      : typeof entry.repositoryName === "string" && entry.repositoryName.trim()
        ? entry.repositoryName.trim()
        : null;

  if (owner && name) {
    return repoCacheKey(`${owner}/${name}`);
  }

  return null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function projectFromRepository(
  repository,
  status,
  projectIdentity = null,
  remoteHead = null,
) {
  return {
    id: projectIdentity?.projectId || String(repository.id),
    repoId: repository.id,
    nodeId: repository.node_id || null,
    name: repository.name,
    title: projectIdentity?.title || repository.name,
    status,
    fullName: repository.full_name,
    htmlUrl: repository.html_url || null,
    private: Boolean(repository.private),
    description: repository.description || null,
    defaultBranchName: remoteHead?.defaultBranchName || repository.default_branch || null,
    defaultBranchHeadOid: remoteHead?.defaultBranchHeadOid || null,
  };
}

export async function ensureGnosisRepoPropertiesSchema({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireOwner: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await ensureRepositoryPropertiesSchema(orgLogin, installationToken);
}

export async function assembleGnosisProjects({ installationId, installationToken, context }) {
  const { repositories, remoteHeadsByRepoKey, orgPropertyMap } = context;
  const cache = pruneInstallationProjectCache(installationId, repositories);
  const repositoryInfos = repositories.map((repository) => ({
    repository,
    isProject: isProjectRepository(
      orgPropertyMap.get(repoCacheKey(repository.full_name)) || [],
    ),
  }));

  const projectInfos = repositoryInfos.filter((info) => info.isProject);
  return mapWithConcurrency(
    projectInfos,
    PROJECT_METADATA_CONCURRENCY,
    async ({ repository }) => {
      const remoteHead =
        remoteHeadsByRepoKey.get(normalizeRepositoryKey(repository.full_name)) || null;
      const remoteHeadOid = remoteHead?.defaultBranchHeadOid || null;
      let projectIdentity = loadCachedProjectMetadata(cache, repository.full_name, remoteHeadOid);

      if (!projectIdentity) {
        try {
          projectIdentity = await loadProjectIdentity(repository.full_name, installationToken);
          saveCachedProjectMetadata(cache, repository.full_name, remoteHeadOid, projectIdentity);
        } catch {}
      }

      return projectFromRepository(
        repository,
        projectIdentity?.status || GNOSIS_TMS_REPO_STATUS_ACTIVE,
        projectIdentity,
        remoteHead,
      );
    },
  );
}

export async function listGnosisProjectsForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  const context = await loadInstallationRepositoryContext(installationToken);
  return assembleGnosisProjects({ installationId, installationToken, context });
}

export async function getInstallationGitTransportToken({ installationId, brokerSession }) {
  const installation = await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const readOnly = isReadOnlyInstallationAccess(installation);
  const token = await createInstallationAccessToken(
    installationId,
    readOnly
      ? { permissions: { contents: "read", metadata: "read" } }
      : {},
  );
  return { token, readOnly };
}

export async function createGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  projectTitle,
  projectId,
  brokerSession,
}) {
  const installationToken = await createInstallationAccessToken(installationId);
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  await ensureGnosisRepoPropertiesSchema({ installationId, orgLogin, brokerSession });

  const repositoryResponse = await githubApi(`/orgs/${orgLogin}/repos`, {
    method: "POST",
    headers: authHeaders(installationToken),
    body: JSON.stringify({
      name: repoName,
      private: true,
    }),
  });
  const repository = await repositoryResponse.json();

  await assignInitialProjectProperties(orgLogin, repository.name, installationToken);
  const projectIdentity = await initializeProjectMetadata(
    repository.full_name,
    projectTitle,
    projectId,
    installationToken,
  );
  return projectFromRepository(repository, GNOSIS_TMS_REPO_STATUS_ACTIVE, {
    projectId: projectIdentity.projectId,
    title: projectIdentity.title,
  });
}

export async function markGnosisProjectRepoDeleted({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await updateProjectLifecycle(
    `${orgLogin}/${repoName}`,
    GNOSIS_TMS_REPO_STATUS_DELETED,
    installationToken,
  );
}

export async function restoreGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await updateProjectLifecycle(
    `${orgLogin}/${repoName}`,
    GNOSIS_TMS_REPO_STATUS_ACTIVE,
    installationToken,
  );
}

export async function renameGnosisProjectRepo({
  installationId,
  fullName,
  projectTitle,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await renameProjectMetadata(fullName, projectTitle, installationToken);
}

export async function permanentlyDeleteGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireOwner: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await deleteRepository(orgLogin, repoName, installationToken);
}

export async function upsertGnosisProjectMetadataRecord({
  installationId,
  orgLogin,
  brokerSession,
  ...input
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  await upsertProjectTeamMetadataRecord({
    installationId,
    orgLogin,
    brokerSession,
    ...input,
  });
}

export async function deleteGnosisProjectMetadataRecord({
  installationId,
  orgLogin,
  projectId,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  await deleteProjectTeamMetadataRecord({
    installationId,
    orgLogin,
    projectId,
  });
}

export async function listGnosisProjectMetadataRecords({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  return listProjectTeamMetadataRecords({
    installationId,
    orgLogin,
  });
}
