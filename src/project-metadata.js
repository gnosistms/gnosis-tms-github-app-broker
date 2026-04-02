import crypto from "node:crypto";

import { githubApi } from "./github-app.js";

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
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

export async function getProjectJsonWithSha(fullName, installationToken) {
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

export async function loadProjectIdentity(fullName, installationToken) {
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

export async function initializeProjectMetadata(fullName, projectTitle, installationToken) {
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

  await updateRepositoryFile({
    fullName,
    path: "project.json",
    message: "Initialize project metadata",
    content: projectJson,
    installationToken,
  });

  await updateRepositoryFile({
    fullName,
    path: ".gitattributes",
    message: "Initialize Git attributes",
    content: "*.json text eol=lf\nassets/** binary\n",
    installationToken,
  });

  return {
    projectId,
    title: projectTitle,
  };
}

export async function renameProjectMetadata(fullName, projectTitle, installationToken) {
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
