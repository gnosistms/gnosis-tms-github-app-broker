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
  githubAppClientId: optional("GITHUB_APP_CLIENT_ID", optional("GITHUB_OAUTH_CLIENT_ID")),
  githubAppClientSecret: optional(
    "GITHUB_APP_CLIENT_SECRET",
    optional("GITHUB_OAUTH_CLIENT_SECRET"),
  ),
  githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  brokerStateSecret: required("BROKER_STATE_SECRET"),
  brokerToken: optional("BROKER_TOKEN"),
  allowedDesktopCallbackPrefixes: parseAllowedDesktopPrefixes(
    optional("ALLOWED_DESKTOP_CALLBACK_PREFIXES", "http://127.0.0.1:45873/"),
  ),
};

if (!config.githubAppClientId) {
  throw new Error(
    "Missing required environment variable: GITHUB_APP_CLIENT_ID (or legacy GITHUB_OAUTH_CLIENT_ID)",
  );
}

if (!config.githubAppClientSecret) {
  throw new Error(
    "Missing required environment variable: GITHUB_APP_CLIENT_SECRET (or legacy GITHUB_OAUTH_CLIENT_SECRET)",
  );
}
