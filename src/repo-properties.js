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
