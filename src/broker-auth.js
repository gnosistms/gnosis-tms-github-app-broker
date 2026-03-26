import { config } from "./config.js";
import { createBrokerSession, destroyBrokerSession, getBrokerSession } from "./broker-sessions.js";
import { decodeInstallState, encodeInstallState } from "./install-state.js";
import { ensureAllowedDesktopCallback } from "./security.js";

function githubOauthCallbackUrl(request) {
  return new URL("/auth/github/callback", `${request.protocol}://${request.get("host")}`).toString();
}

export function buildGithubOauthStartUrl(request, desktopRedirectUri, desktopState) {
  const state = encodeInstallState({
    desktopRedirectUri,
    desktopState,
    createdAt: new Date().toISOString(),
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubOauthClientId);
  url.searchParams.set("redirect_uri", githubOauthCallbackUrl(request));
  url.searchParams.set("scope", "read:org");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGithubOauthCode(request, code) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "gnosis-tms-github-app-broker",
    },
    body: JSON.stringify({
      client_id: config.githubOauthClientId,
      client_secret: config.githubOauthClientSecret,
      code,
      redirect_uri: githubOauthCallbackUrl(request),
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "GitHub OAuth exchange failed.");
  }

  return payload.access_token;
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
  return createBrokerSession({
    accessToken,
    user,
  });
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

export function revokeBrokerSessionFromHeader(request) {
  const header = request.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return;
  }

  destroyBrokerSession(header.slice("Bearer ".length).trim());
}
