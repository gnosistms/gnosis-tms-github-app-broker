import { config } from "./config.js";
import {
  createBrokerSession,
  destroyBrokerSession,
  getBrokerSession,
  getRefreshableBrokerSession,
} from "./broker-sessions.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { ensureAllowedDesktopCallback } from "./security.js";

const ALLOWED_GITHUB_OAUTH_PROMPTS = new Set(["select_account"]);

function githubOauthCallbackUrl() {
  return new URL("/auth/github/callback", config.publicBaseUrl).toString();
}

function normalizeGithubOauthPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) {
    return null;
  }
  if (!ALLOWED_GITHUB_OAUTH_PROMPTS.has(prompt)) {
    throw new Error("Unsupported GitHub OAuth prompt.");
  }
  return prompt;
}

export function buildGithubOauthStartUrl(_request, desktopRedirectUri, desktopState, options = {}) {
  const state = encodeInstallState({
    desktopRedirectUri,
    desktopState,
    createdAt: new Date().toISOString(),
  });
  const prompt = normalizeGithubOauthPrompt(options.prompt);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubAppClientId);
  url.searchParams.set("redirect_uri", githubOauthCallbackUrl());
  url.searchParams.set("state", state);
  if (prompt) {
    url.searchParams.set("prompt", prompt);
  }
  return url.toString();
}

export async function exchangeGithubOauthCode(_request, code) {
  return requestGithubUserToken({
    client_id: config.githubAppClientId,
    client_secret: config.githubAppClientSecret,
    code,
    redirect_uri: githubOauthCallbackUrl(),
  });
}

export async function refreshGithubUserAccessToken(refreshToken) {
  return requestGithubUserToken({
    client_id: config.githubAppClientId,
    client_secret: config.githubAppClientSecret,
    grant_type: "refresh_token",
    refresh_token: String(refreshToken || "").trim(),
  });
}

async function requestGithubUserToken(params) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "gnosis-tms-github-app-broker",
    },
    body: new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    ).toString(),
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub OAuth exchange failed.");
  }

  return payload;
}

export async function loadGithubUser(accessToken) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gnosis-tms-github-app-broker",
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Could not load the GitHub user.");
  }

  return {
    id: payload.id,
    login: payload.login,
    name: payload.name || null,
    avatarUrl: payload.avatar_url || null,
  };
}

export function createBrokerSessionForGithubUser(accessToken, user) {
  const accessTokenExpiresAt = resolveRelativeExpiry(accessToken?.expires_in);
  const refreshTokenExpiresAt = resolveRelativeExpiry(accessToken?.refresh_token_expires_in);
  return createBrokerSession({
    accessToken: accessToken.access_token,
    accessTokenExpiresAt,
    refreshToken: accessToken.refresh_token || null,
    refreshTokenExpiresAt,
    user,
  });
}

export async function refreshBrokerSessionForGithubUser(brokerSession) {
  const refreshToken = String(brokerSession?.refreshToken || "").trim();
  if (!refreshToken) {
    throw new Error("This GitHub session cannot be refreshed. Please sign in again.");
  }

  const tokenPayload = await refreshGithubUserAccessToken(refreshToken);
  const user = await loadGithubUser(tokenPayload.access_token);
  return {
    sessionToken: createBrokerSessionForGithubUser(tokenPayload, user),
    user,
  };
}

export function decodeBrokerOauthState(state) {
  return decodeInstallState(state);
}

export function validateDesktopRedirectUri(value) {
  return ensureAllowedDesktopCallback(value);
}

export function loadBrokerSessionFromHeader(request) {
  const header = request.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return getBrokerSession(header.slice("Bearer ".length).trim());
}

export function loadRefreshableBrokerSessionFromHeader(request) {
  const header = request.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return getRefreshableBrokerSession(header.slice("Bearer ".length).trim());
}

export function revokeBrokerSessionFromHeader(request) {
  const header = request.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return;
  }

  destroyBrokerSession(header.slice("Bearer ".length).trim());
}

function resolveRelativeExpiry(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Date.now() + parsed * 1000;
}
