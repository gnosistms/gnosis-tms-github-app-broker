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

// GitHub intermittently serves transient 5xx errors ("Unicorn!" pages). Idempotent
// reads are retried with a short backoff so one dropped sub-request cannot ripple
// into a wrong answer — most critically a silently shortened installations listing
// (the 2026-07-14 disappearing-teams incident). Writes are never retried: a replayed
// mutation could double-apply.
const GITHUB_RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const GITHUB_RETRY_DELAYS_MS = [500, 2000];
const GITHUB_RETRY_AFTER_CAP_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubRetryDelayMs(response, attempt) {
  const retryAfterSeconds = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, GITHUB_RETRY_AFTER_CAP_MS);
  }
  return GITHUB_RETRY_DELAYS_MS[attempt];
}

export async function githubApi(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const maxRetries =
    method === "GET" || method === "HEAD" ? GITHUB_RETRY_DELAYS_MS.length : 0;

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "gnosis-tms-github-app-broker",
          ...(options.headers || {}),
        },
      });
    } catch (networkError) {
      if (attempt < maxRetries) {
        await sleep(GITHUB_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw networkError;
    }

    if (!response.ok) {
      if (attempt < maxRetries && GITHUB_RETRYABLE_STATUSES.has(response.status)) {
        await sleep(githubRetryDelayMs(response, attempt));
        continue;
      }
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
}

export async function githubGraphql(query, variables = {}, options = {}) {
  const response = await githubApi("/graphql", {
    method: "POST",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((error) => error?.message || "Unknown GraphQL error")
      .join("; ");
    const graphQlError = new Error(`GitHub GraphQL API: ${message}`);
    graphQlError.githubErrors = payload.errors;
    throw graphQlError;
  }

  return payload.data || {};
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
    accountId: installation.account?.id || null,
    accountType: installation.account?.type || "",
    accountAvatarUrl: installation.account?.avatar_url || null,
    accountHtmlUrl: installation.account?.html_url || null,
    installationHtmlUrl: installation.html_url || null,
    appSlug: installation.app_slug || config.githubAppSlug,
    targetType: installation.target_type || installation.account?.type || "",
    permissions: installation.permissions || {},
  };
}

// GitHub installation tokens are valid for one hour; minting a fresh one per request
// added a sequential GitHub round trip to every authorized broker call. Cache per
// installation and permission variant (a read-only transport token must never be
// served where a full-permission token was requested, and vice versa), refreshed
// five minutes before expiry. Webhook installation events clear the cache so an
// uninstall does not leave dead tokens behind.
const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const installationTokenCache = new Map();

function installationTokenCacheKey(installationId, options) {
  const permissions =
    options?.permissions && typeof options.permissions === "object"
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(options.permissions).sort(([left], [right]) =>
              left.localeCompare(right)
            ),
          ),
        )
      : "";
  return `${installationId}:${permissions}`;
}

export function clearInstallationTokenCache(installationId) {
  const prefix = `${installationId}:`;
  for (const key of installationTokenCache.keys()) {
    if (key.startsWith(prefix)) {
      installationTokenCache.delete(key);
    }
  }
}

export function resetInstallationTokenCacheForTests() {
  installationTokenCache.clear();
}

export async function createInstallationAccessToken(installationId, options = {}) {
  const cacheKey = installationTokenCacheKey(installationId, options);
  const cached = installationTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.reuseUntil) {
    return cached.token;
  }

  const body = {};
  if (options?.permissions && typeof options.permissions === "object") {
    body.permissions = options.permissions;
  }

  const response = await githubApi(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubAppJwt()}`,
      ...(Object.keys(body).length ? { "Content-Type": "application/json" } : {}),
    },
    ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json();
  const expiresAt = Date.parse(payload.expires_at);
  if (Number.isFinite(expiresAt)) {
    installationTokenCache.set(cacheKey, {
      token: payload.token,
      reuseUntil: expiresAt - INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
    });
  }
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
