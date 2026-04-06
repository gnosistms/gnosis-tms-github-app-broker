import {
  GNOSIS_TMS_REPO_STATUS_ACTIVE,
  GNOSIS_TMS_REPO_STATUS_DELETED,
} from "./constants.js";
import { ensureInstallationAccess } from "./installation-access.js";
import {
  createInstallationAccessToken,
  githubApi,
  githubGraphql,
} from "./github-app.js";
import {
  assignInitialProjectProperties,
  deleteRepository,
  ensureRepositoryPropertiesSchema,
  getRepositoryProperties,
  isProjectRepository,
  isSoftDeletedRepository,
  updateRepositoryStatus,
} from "./repo-properties.js";
import {
  initializeProjectMetadata,
  loadProjectIdentity,
  renameProjectMetadata,
} from "./project-metadata.js";

const INSTALLATION_REPOSITORIES_PER_PAGE = 100;
const REPOSITORY_REMOTE_HEADS_QUERY = `
  query RepositoryRemoteHeads($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Repository {
        id
        nameWithOwner
        defaultBranchRef {
          name
          target {
            ... on Commit {
              oid
            }
          }
        }
      }
    }
  }
`;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function normalizeRepositoryKey(value) {
  return String(value || "").trim().toLowerCase();
}

function chunk(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
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

async function listInstallationRepositoriesRaw(installationToken) {
  const repositories = [];
  let page = 1;

  while (true) {
    const response = await githubApi(
      `/installation/repositories?per_page=${INSTALLATION_REPOSITORIES_PER_PAGE}&page=${page}`,
      {
        headers: authHeaders(installationToken),
      },
    );
    const payload = await response.json();
    const batch = payload.repositories || [];
    repositories.push(...batch);

    if (batch.length < INSTALLATION_REPOSITORIES_PER_PAGE) {
      break;
    }

    page += 1;
  }

  return repositories;
}

async function loadRepositoryRemoteHeadsMap(repositories, installationToken) {
  const nodeIds = repositories
    .map((repository) => repository.node_id)
    .filter((value) => typeof value === "string" && value.trim().length > 0);
  const remoteHeadsByRepoKey = new Map();

  for (const ids of chunk(nodeIds, 100)) {
    const data = await githubGraphql(
      REPOSITORY_REMOTE_HEADS_QUERY,
      { ids },
      { headers: authHeaders(installationToken) },
    );
    for (const node of data.nodes || []) {
      if (!node || typeof node.nameWithOwner !== "string") {
        continue;
      }

      remoteHeadsByRepoKey.set(normalizeRepositoryKey(node.nameWithOwner), {
        defaultBranchName: node.defaultBranchRef?.name || null,
        defaultBranchHeadOid: node.defaultBranchRef?.target?.oid || null,
      });
    }
  }

  return remoteHeadsByRepoKey;
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

export async function listGnosisProjectsForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  const repositories = await listInstallationRepositoriesRaw(installationToken);
  const remoteHeadsByRepoKey = await loadRepositoryRemoteHeadsMap(repositories, installationToken);
  const projects = [];

  for (const repository of repositories) {
    const properties = await getRepositoryProperties(repository.full_name, installationToken);
    const isProject = isProjectRepository(properties);
    const isDeleted = isSoftDeletedRepository(properties);

    if (!isProject) {
      continue;
    }

    let projectIdentity = null;
    try {
      projectIdentity = await loadProjectIdentity(repository.full_name, installationToken);
    } catch {}

    projects.push(
      projectFromRepository(
        repository,
        isDeleted ? GNOSIS_TMS_REPO_STATUS_DELETED : GNOSIS_TMS_REPO_STATUS_ACTIVE,
        projectIdentity,
        remoteHeadsByRepoKey.get(normalizeRepositoryKey(repository.full_name)) || null,
      ),
    );
  }

  return projects;
}

export async function getInstallationGitTransportToken({ installationId, brokerSession }) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const token = await createInstallationAccessToken(installationId);
  return { token };
}

export async function createGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  projectTitle,
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
  await updateRepositoryStatus(orgLogin, repoName, GNOSIS_TMS_REPO_STATUS_DELETED, installationToken);
}

export async function restoreGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await updateRepositoryStatus(orgLogin, repoName, GNOSIS_TMS_REPO_STATUS_ACTIVE, installationToken);
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
