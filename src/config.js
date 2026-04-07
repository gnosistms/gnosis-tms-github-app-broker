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

function parsePositiveInteger(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return value;
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
  adminTeamSlug: optional("GNOSIS_ADMIN_TEAM_SLUG", "admins"),
  githubAppId: required("GITHUB_APP_ID"),
  githubAppSlug: required("GITHUB_APP_SLUG"),
  githubAppClientId: required("GITHUB_APP_CLIENT_ID"),
  githubAppClientSecret: required("GITHUB_APP_CLIENT_SECRET"),
  githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  brokerStateSecret: required("BROKER_STATE_SECRET"),
  brokerToken: optional("BROKER_TOKEN"),
  brokerSessionTtlDays: parsePositiveInteger("BROKER_SESSION_TTL_DAYS", 90),
  allowedDesktopCallbackPrefixes: parseAllowedDesktopPrefixes(
    optional("ALLOWED_DESKTOP_CALLBACK_PREFIXES", "http://127.0.0.1:45873/"),
  ),
};
