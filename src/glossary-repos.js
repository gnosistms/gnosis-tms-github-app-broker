import { ensureInstallationAccess } from "./installation-access.js";
import {
  createInstallationAccessToken,
  githubApi,
  githubGraphql,
} from "./github-app.js";
import {
  assignInitialGlossaryProperties,
  deleteRepository,
  ensureRepositoryPropertiesSchema,
  isGlossaryRepository,
  listOrganizationRepositoryPropertyValues,
} from "./repo-properties.js";
import {
  deleteGlossaryMetadataRecord as deleteGlossaryTeamMetadataRecord,
  listGlossaryMetadataRecords as listGlossaryTeamMetadataRecords,
  upsertGlossaryMetadataRecord as upsertGlossaryTeamMetadataRecord,
} from "./team-metadata-repo.js";

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

function propertiesFromOrganizationEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  if (Array.isArray(entry.properties)) {
    return entry.properties;
  }

  if (Array.isArray(entry.property_values)) {
    return entry.property_values;
  }

  if (Array.isArray(entry.propertyValues)) {
    return entry.propertyValues;
  }

  return [];
}

function buildOrgPropertyMap(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const key = propertyRepositoryKey(entry);
    if (!key) {
      continue;
    }
    map.set(key, propertiesFromOrganizationEntry(entry));
  }
  return map;
}

function deriveOrgLoginFromRepositories(repositories) {
  for (const repository of repositories || []) {
    const ownerLogin =
      typeof repository?.owner?.login === "string" && repository.owner.login.trim()
        ? repository.owner.login.trim()
        : null;
    if (ownerLogin) {
      return ownerLogin;
    }

    const fullName =
      typeof repository?.full_name === "string" && repository.full_name.trim()
        ? repository.full_name.trim()
        : null;
    if (fullName && fullName.includes("/")) {
      return fullName.split("/")[0];
    }
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

export async function listGnosisGlossariesForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  const repositories = await listInstallationRepositoriesRaw(installationToken);
  const remoteHeadsByRepoKey = await loadRepositoryRemoteHeadsMap(repositories, installationToken);
  const orgLogin = deriveOrgLoginFromRepositories(repositories);
  const organizationPropertyValues = orgLogin
    ? await listOrganizationRepositoryPropertyValues(orgLogin, installationToken)
    : [];
  const orgPropertyMap = buildOrgPropertyMap(organizationPropertyValues);

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
