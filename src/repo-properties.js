import {
  GNOSIS_TMS_REPO_TYPE_GLOSSARY,
  GNOSIS_TMS_REPO_TYPE_PROJECT,
  GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
} from "./constants.js";
import { githubApi } from "./github-app.js";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

const ORGANIZATION_REPOSITORY_PROPERTY_VALUES_PER_PAGE = 100;
const PERMISSION_LEVELS = {
  read: 1,
  write: 2,
  admin: 3,
};

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
    ],
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

function normalizePermissionLevel(level) {
  return typeof level === "string" && level.trim()
    ? level.trim().toLowerCase()
    : "";
}

function normalizePermissions(permissions) {
  if (!permissions || typeof permissions !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(permissions)
      .map(([key, value]) => [
        typeof key === "string" ? key.trim() : "",
        normalizePermissionLevel(value),
      ])
      .filter(([key, value]) => key && value),
  );
}

function missingCustomPropertiesPermission(permissions) {
  const normalizedPermissions = normalizePermissions(permissions);
  const grantedLevel = ["custom_properties", "repository_custom_properties"].reduce((bestLevel, key) => {
    const nextLevel = normalizedPermissions[key];
    return (PERMISSION_LEVELS[nextLevel] ?? 0) > (PERMISSION_LEVELS[bestLevel] ?? 0)
      ? nextLevel
      : bestLevel;
  }, "");

  return (PERMISSION_LEVELS[grantedLevel] ?? 0) < PERMISSION_LEVELS.write;
}

export function describeRepositoryPropertiesSchemaFailure(error, context = {}) {
  const orgLogin = typeof context.orgLogin === "string" ? context.orgLogin.trim() : "";
  const accountType = typeof context.accountType === "string" ? context.accountType.trim() : "";
  const permissions = normalizePermissions(context.permissions);
  const permissionsJson = JSON.stringify(permissions);
  const rawBody =
    typeof error?.githubBody === "string" && error.githubBody.trim()
      ? error.githubBody.trim()
      : error?.message ?? String(error);
  const likelyCause = missingCustomPropertiesPermission(permissions)
    ? "The installation permission snapshot does not appear to include writable custom properties access."
    : "The installation permission snapshot appears to include custom properties access, so GitHub may be hiding this endpoint for the org/account context or for this installation token.";

  return [
    `Failed while configuring the organization-level GitHub custom property schema for @${orgLogin || "unknown-org"}.`,
    `This step runs before any project or glossary repos exist; it only updates the org schema for ${GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME}.`,
    accountType ? `Installation account type: ${accountType}.` : "",
    `Installation permissions: ${permissionsJson}.`,
    likelyCause,
    `Raw GitHub response body: ${rawBody}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function ensureRepositoryPropertiesSchema(orgLogin, installationToken) {
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

export async function listOrganizationRepositoryPropertyValues(orgLogin, installationToken) {
  const repositoryPropertyValues = [];
  let page = 1;

  while (true) {
    const response = await githubApi(
      `/orgs/${orgLogin}/properties/values?per_page=${ORGANIZATION_REPOSITORY_PROPERTY_VALUES_PER_PAGE}&page=${page}`,
      {
        headers: authHeaders(installationToken),
      },
    );
    const payload = await response.json();
    const batch = Array.isArray(payload) ? payload : [];
    repositoryPropertyValues.push(...batch);

    if (batch.length < ORGANIZATION_REPOSITORY_PROPERTY_VALUES_PER_PAGE) {
      break;
    }

    page += 1;
  }

  return repositoryPropertyValues;
}

export function isProjectRepository(properties) {
  return properties.some(
    (property) =>
      property.property_name === GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME &&
      propertyValueMatches(property.value, GNOSIS_TMS_REPO_TYPE_PROJECT),
  );
}

export function isGlossaryRepository(properties) {
  return properties.some(
    (property) =>
      property.property_name === GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME &&
      propertyValueMatches(property.value, GNOSIS_TMS_REPO_TYPE_GLOSSARY),
  );
}

export async function assignInitialProjectProperties(orgLogin, repoName, installationToken) {
  try {
    await githubApi(`/repos/${orgLogin}/${repoName}/properties/values`, {
      method: "PATCH",
      headers: authHeaders(installationToken),
      body: JSON.stringify({
        properties: [
          {
            property_name: GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
            value: GNOSIS_TMS_REPO_TYPE_PROJECT,
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
}

export async function assignInitialGlossaryProperties(orgLogin, repoName, installationToken) {
  try {
    await githubApi(`/repos/${orgLogin}/${repoName}/properties/values`, {
      method: "PATCH",
      headers: authHeaders(installationToken),
      body: JSON.stringify({
        properties: [
          {
            property_name: GNOSIS_TMS_REPO_TYPE_PROPERTY_NAME,
            value: GNOSIS_TMS_REPO_TYPE_GLOSSARY,
          },
        ],
      }),
    });
  } catch (error) {
    if (error.githubStatus === 403) {
      throw new Error(
        "GitHub rejected the Gnosis TMS glossary property update. The Gnosis TMS GitHub App needs the repository permission `Custom properties: Read and write`, and the installation may need to be updated after you save that permission.",
      );
    }
    throw error;
  }
}

export async function deleteRepository(orgLogin, repoName, installationToken) {
  try {
    await githubApi(`/repos/${orgLogin}/${repoName}`, {
      method: "DELETE",
      headers: authHeaders(installationToken),
    });
  } catch (error) {
    if (error?.githubStatus === 404) {
      return;
    }
    throw error;
  }
}
