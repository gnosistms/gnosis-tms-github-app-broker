import crypto from "node:crypto";

import {
  GNOSIS_TMS_REPO_STATUS_ACTIVE,
  GNOSIS_TMS_REPO_STATUS_DELETED,
  GNOSIS_TMS_REPO_STATUS_PROPERTY_NAME,
  GNOSIS_TMS_REPO_TYPE_GLOSSARY,
  GNOSIS_TMS_REPO_TYPE_PROJECT,
  GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
} from "./constants.js";
import { ensureInstallationAccess } from "./authorization.js";
import {
  createInstallationAccessToken,
  githubApi,
} from "./github-app.js";

function createPropertySchemaPayload() {
  return {
    properties: [
      {
        property_name: GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
        value_type: "single_select",
        description: "Identifies the role of repositories created by Gnosis TMS.",
        allowed_values: [
          GNOSIS_TMS_REPO_TYPE_PROJECT,
          GNOSIS_TMS_REPO_TYPE_GLOSSARY,
        ],
        values_editable_by: "org_actors",
        required: false,
      },
      {
        property_name: GNOSIS_TMS_REPO_STATUS_PROPERTY_NAME,
        value_type: "single_select",
        description: "Tracks whether a Gnosis TMS repository is active or soft deleted.",
        allowed_values: [
          GNOSIS_TMS_REPO_STATUS_ACTIVE,
          GNOSIS_TMS_REPO_STATUS_DELETED,
        ],
        values_editable_by: "org_actors",
        required: false,
      },
    ],
  };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function propertyValueMatches(value, expected) {
  if (typeof value === "string") {
    return value === expected;
  }

  if (Array.isArray(value)) {
    return value.includes(expected);
  }

  return false;
}

async function getRepositoryProperties(fullName, installationToken) {
  const response = await githubApi(`/repos/${fullName}/properties/values`, {
    headers: authHeaders(installationToken),
  });
  return response.json();
}

async function getProjectJsonWithSha(fullName, installationToken) {
  const response = await githubApi(`/repos/${fullName}/contents/project.json`, {
    headers: authHeaders(installationToken),
  });
  const payload = await response.json();

  if (payload.encoding !== "base64") {
    throw new Error(`Unexpected project.json encoding for ${fullName}: ${payload.encoding}`);
  }

  const decoded = Buffer.from(String(payload.content || "").replace(/\n/g, ""), "base64")
    .toString("utf8");
  const value = JSON.parse(decoded);

  return {
    value,
    sha: payload.sha,
  };
}

async function updateRepositoryFile({
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

async function createRepositoryFile({
  fullName,
  path,
  message,
  content,
  installationToken,
}) {
  return updateRepositoryFile({
    fullName,
    path,
    message,
    content,
    installationToken,
  });
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

async function loadProjectIdentity(fullName, installationToken) {
  const { value } = await getProjectJsonWithSha(fullName, installationToken);
  if (!value || typeof value !== "object") {
    throw new Error(`project.json in ${fullName} is not an object`);
  }

  const projectId =
    typeof value.project_id === "string" && value.project_id.trim()
      ? value.project_id
      : null;
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title
      : null;

  if (!projectId || !title) {
    throw new Error(`project.json in ${fullName} is missing project_id or title`);
  }

  return { projectId, title };
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
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);

  try {
    await githubApi(`/orgs/${orgLogin}/properties/schema`, {
      method: "PATCH",
      headers: authHeaders(installationToken),
      body: JSON.stringify(createPropertySchemaPayload()),
    });
  } catch (error) {
    const status = error.githubStatus;
    if (status === 403) {
      throw new Error(
        "GitHub rejected the repository property schema update. The Gnosis TMS GitHub App needs the organization permission `Custom properties: Admin`.",
      );
    }
    throw error;
  }
}

export async function listGnosisProjectsForInstallation(installationId, brokerSession) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: false });
  const installationToken = await createInstallationAccessToken(installationId);
  const repositories = await listInstallationRepositoriesRaw(installationToken);
  const projects = [];

  for (const repository of repositories) {
    const properties = await getRepositoryProperties(repository.full_name, installationToken);
    const isProject = properties.some(
      (property) =>
        property.property_name === GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME &&
        propertyValueMatches(property.value, GNOSIS_TMS_REPO_TYPE_PROJECT),
    );
    const isDeleted = properties.some(
      (property) =>
        property.property_name === GNOSIS_TMS_REPO_STATUS_PROPERTY_NAME &&
        propertyValueMatches(property.value, GNOSIS_TMS_REPO_STATUS_DELETED),
    );

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
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: true });
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

  try {
    await githubApi(`/repos/${orgLogin}/${repository.name}/properties/values`, {
      method: "PATCH",
      headers: authHeaders(installationToken),
      body: JSON.stringify({
        properties: [
          {
            property_name: GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
            value: GNOSIS_TMS_REPO_TYPE_PROJECT,
          },
          {
            property_name: GNOSIS_TMS_REPO_STATUS_PROPERTY_NAME,
            value: GNOSIS_TMS_REPO_STATUS_ACTIVE,
          },
        ],
      }),
    });
  } catch (error) {
    if (error.githubStatus === 403) {
      throw new Error(
        "GitHub rejected the Gnosis TMS project property update. The Gnosis TMS GitHub App needs the repository permission `Custom properties: Read and write`, and the installation may need to be updated after you save that permission.",
      );
    }
    throw error;
  }

  const projectId = crypto.randomUUID();
  const projectJson = JSON.stringify(
    {
      project_id: projectId,
      title: projectTitle,
      chapter_order: [],
    },
    null,
    2,
  );

  await createRepositoryFile({
    fullName: repository.full_name,
    path: "project.json",
    message: "Initialize project metadata",
    content: projectJson,
    installationToken,
  });

  await createRepositoryFile({
    fullName: repository.full_name,
    path: ".gitattributes",
    message: "Initialize Git attributes",
    content: "*.json text eol=lf\nassets/** binary\n",
    installationToken,
  });

  return projectFromRepository(repository, GNOSIS_TMS_REPO_STATUS_ACTIVE, {
    projectId,
    title: projectTitle,
  });
}

export async function markGnosisProjectRepoDeleted({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await githubApi(`/repos/${orgLogin}/${repoName}/properties/values`, {
    method: "PATCH",
    headers: authHeaders(installationToken),
    body: JSON.stringify({
      properties: [
        {
          property_name: GNOSIS_TMS_REPO_STATUS_PROPERTY_NAME,
          value: GNOSIS_TMS_REPO_STATUS_DELETED,
        },
      ],
    }),
  });
}

export async function renameGnosisProjectRepo({
  installationId,
  fullName,
  projectTitle,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  const { value, sha } = await getProjectJsonWithSha(fullName, installationToken);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`project.json in ${fullName} is not an object`);
  }

  value.title = projectTitle;

  await updateRepositoryFile({
    fullName,
    path: "project.json",
    message: "Rename project",
    content: JSON.stringify(value, null, 2),
    installationToken,
    sha,
  });
}

export async function permanentlyDeleteGnosisProjectRepo({
  installationId,
  orgLogin,
  repoName,
  brokerSession,
}) {
  await ensureInstallationAccess({ installationId, brokerSession, requireAdmin: true });
  const installationToken = await createInstallationAccessToken(installationId);
  await githubApi(`/repos/${orgLogin}/${repoName}`, {
    method: "DELETE",
    headers: authHeaders(installationToken),
  });
}
