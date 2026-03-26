import jwt from "jsonwebtoken";

import { config } from "./config.js";

const GITHUB_API_VERSION = "2022-11-28";

export function githubAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 9 * 60,
      iss: config.githubAppId,
    },
    config.githubAppPrivateKey,
    {
      algorithm: "RS256",
      header: { typ: "JWT" },
    },
  );
}

export async function githubApi(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "gnosis-tms-github-app-broker",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(
      parseGithubError(response.status, body || response.statusText),
    );
    error.githubStatus = response.status;
    error.githubBody = body;
    throw error;
  }

  return response;
}

export function parseGithubError(status, body) {
  return `GitHub API ${status}: ${body}`;
}

export async function getInstallation(installationId) {
  const response = await githubApi(`/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${githubAppJwt()}`,
    },
  });

  const installation = await response.json();
  return {
    installationId: installation.id,
    accountLogin: installation.account?.login || "",
    accountType: installation.account?.type || "",
    accountAvatarUrl: installation.account?.avatar_url || null,
    accountHtmlUrl: installation.account?.html_url || null,
  };
}

export async function createInstallationAccessToken(installationId) {
  const response = await githubApi(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubAppJwt()}`,
    },
  });

  const payload = await response.json();
  return payload.token;
}

export async function listInstallationRepositories(installationId) {
  const installationToken = await createInstallationAccessToken(installationId);
  const response = await githubApi("/installation/repositories", {
    headers: {
      Authorization: `Bearer ${installationToken}`,
    },
  });

  const payload = await response.json();
  return (payload.repositories || []).map((repository) => ({
    id: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    htmlUrl: repository.html_url || null,
    private: Boolean(repository.private),
    description: repository.description || null,
  }));
}
