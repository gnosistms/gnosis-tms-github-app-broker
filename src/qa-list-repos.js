import { ensureInstallationAccess } from "./installation-access.js";
import {
  createInstallationAccessToken,
  githubApi,
} from "./github-app.js";
import {
  assignInitialQaListProperties,
  deleteRepository,
  ensureRepositoryPropertiesSchema,
  isQaListRepository,
} from "./repo-properties.js";
import {
  authHeaders,
  loadInstallationRepositoryContext,
  normalizeRepositoryKey,
} from "./installation-repos.js";


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
    return normalizeRepositoryKey(fullName);
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
    return normalizeRepositoryKey(`${owner}/${name}`);
  }

  return null;
}

function qaListFromRepository(repository, remoteHead = null) {
  return {
    repoId: repository.id,
    nodeId: repository.node_id || null,
    name: repository.name,
    fullName: repository.full_name,
    htmlUrl: repository.html_url || null,
    private: Boolean(repository.private),
    description: repository.description || null,
    defaultBranchName: remoteHead?.defaultBranchName || repository.default_branch || null,
    defaultBranchHeadOid: remoteHead?.defaultBranchHeadOid || null,
  };
}

export function assembleGnosisQaLists(context) {
  const { repositories, remoteHeadsByRepoKey, orgPropertyMap } = context;
  return repositories
    .filter((repository) =>
      isQaListRepository(orgPropertyMap.get(normalizeRepositoryKey(repository.full_name)) || [])
    )
    .map((repository) =>
      qaListFromRepository(
        repository,
        remoteHeadsByRepoKey.get(normalizeRepositoryKey(repository.full_name)) || null,
      )
    );
}

export async function listGnosisQaListsForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  return assembleGnosisQaLists(await loadInstallationRepositoryContext(installationToken));
}

export async function createGnosisQaListRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);

  await ensureRepositoryPropertiesSchema(orgLogin, installationToken);

  const repositoryResponse = await githubApi(`/orgs/${orgLogin}/repos`, {
    method: "POST",
    headers: authHeaders(installationToken),
    body: JSON.stringify({
      name: repoName,
      private: true,
    }),
  });
  const repository = await repositoryResponse.json();

  try {
    await assignInitialQaListProperties(orgLogin, repository.name, installationToken);
  } catch (error) {
    try {
      await deleteRepository(orgLogin, repository.name, installationToken);
    } catch (rollbackError) {
      throw new Error(
        `${error?.message ?? String(error)} Automatic QA list repo rollback also failed: ${
          rollbackError?.message ?? String(rollbackError)
        }`,
      );
    }
    throw error;
  }
  return qaListFromRepository(repository);
}

export async function permanentlyDeleteGnosisQaListRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireOwner: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await deleteRepository(orgLogin, repoName, installationToken);
}
