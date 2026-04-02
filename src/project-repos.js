import {
  GNOSIS_TMS_REPO_STATUS_ACTIVE,
  GNOSIS_TMS_REPO_STATUS_DELETED,
} from "./constants.js";
import { ensureInstallationAccess } from "./authorization.js";
import {
  createInstallationAccessToken,
  githubApi,
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

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function projectFromRepository(repository, status, projectIdentity = null) {
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
  };
}

async function listInstallationRepositoriesRaw(installationToken) {
  const response = await githubApi("/installation/repositories?per_page=100", {
    headers: authHeaders(installationToken),
  });
  const payload = await response.json();
  return payload.repositories || [];
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
      ),
    );
  }

  return projects;
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
  await ensureInstallationAccess({ installationId, brokerSession, requireOwner: true });
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
