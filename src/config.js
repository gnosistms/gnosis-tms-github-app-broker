import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function parseAllowedDesktopPrefixes(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: Number.parseInt(optional("PORT", "3000"), 10),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
  githubAppId: required("GITHUB_APP_ID"),
  githubAppSlug: required("GITHUB_APP_SLUG"),
  githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  githubOauthClientId: required("GITHUB_OAUTH_CLIENT_ID"),
  githubOauthClientSecret: required("GITHUB_OAUTH_CLIENT_SECRET"),
  brokerStateSecret: required("BROKER_STATE_SECRET"),
  brokerToken: optional("BROKER_TOKEN"),
  allowedDesktopCallbackPrefixes: parseAllowedDesktopPrefixes(
    optional("ALLOWED_DESKTOP_CALLBACK_PREFIXES", "http://127.0.0.1:45873/"),
  ),
};
