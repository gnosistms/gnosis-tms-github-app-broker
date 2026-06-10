import { ensureInstallationAccess } from "./installation-access.js";
import {
  createInstallationAccessToken,
  githubApi,
} from "./github-app.js";
import {
  assignInitialGlossaryProperties,
  deleteRepository,
  ensureRepositoryPropertiesSchema,
  isGlossaryRepository,
} from "./repo-properties.js";
import {
  deleteGlossaryMetadataRecord as deleteGlossaryTeamMetadataRecord,
  listGlossaryMetadataRecords as listGlossaryTeamMetadataRecords,
  upsertGlossaryMetadataRecord as upsertGlossaryTeamMetadataRecord,
} from "./team-metadata-repo.js";
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

function glossaryFromRepository(repository, remoteHead = null) {
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

export function assembleGnosisGlossaries(context) {
  const { repositories, remoteHeadsByRepoKey, orgPropertyMap } = context;
  return repositories
    .filter((repository) =>
      isGlossaryRepository(orgPropertyMap.get(normalizeRepositoryKey(repository.full_name)) || [])
    )
    .map((repository) =>
      glossaryFromRepository(
        repository,
        remoteHeadsByRepoKey.get(normalizeRepositoryKey(repository.full_name)) || null,
      )
    );
}

export async function listGnosisGlossariesForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  return assembleGnosisGlossaries(await loadInstallationRepositoryContext(installationToken));
}

export async function createGnosisGlossaryRepo({
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

  await assignInitialGlossaryProperties(orgLogin, repository.name, installationToken);
  return glossaryFromRepository(repository);
}

export async function permanentlyDeleteGnosisGlossaryRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireOwner: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await deleteRepository(orgLogin, repoName, installationToken);
}

export async function listGnosisGlossaryMetadataRecords({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  return listGlossaryTeamMetadataRecords({
    installationId,
    orgLogin,
  });
}

export async function upsertGnosisGlossaryMetadataRecord({
  installationId,
  orgLogin,
  brokerSession,
  ...input
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  await upsertGlossaryTeamMetadataRecord({
    installationId,
    orgLogin,
    brokerSession,
    ...input,
  });
}

export async function deleteGnosisGlossaryMetadataRecord({
  installationId,
  orgLogin,
  glossaryId,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireProjectAdmin: true });
  await deleteGlossaryTeamMetadataRecord({
    installationId,
    orgLogin,
    glossaryId,
  });
}
