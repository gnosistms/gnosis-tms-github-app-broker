// Webhook-maintained, per-installation cache of the listing prelude context. GitHub
// pushes change events to /webhooks/github; between events the combined listing serves
// from memory instead of re-enumerating every repo (~6s → sub-second).
//
// Feature-gated on GITHUB_APP_WEBHOOK_SECRET: when unset, every call takes the full
// prelude path, exactly as before the manifest existed. Single-instance assumption:
// webhooks reach one process; the TTL bounds staleness for anything else (missed
// deliveries, a second instance, a misconfigured webhook).
import { config } from "./config.js";
import { clearInstallationTokenCache } from "./github-app.js";
import { clearInstallationAccessCache } from "./installation-access.js";
import {
  loadInstallationRepositoryContext,
  normalizeRepositoryKey,
} from "./installation-repos.js";

const MANIFEST_TTL_MS = 10 * 60 * 1000;
const MANIFEST_DROP_EVENTS = new Set([
  "repository",
  "installation_repositories",
  "installation",
  "custom_property_values",
]);

const manifestsByInstallationId = new Map();

export function installationManifestEnabled() {
  return Boolean(config.githubAppWebhookSecret);
}

export async function getInstallationRepositoryContext(
  installationId,
  installationToken,
  { loadContext = loadInstallationRepositoryContext, now = Date.now } = {},
) {
  if (!installationManifestEnabled()) {
    return loadContext(installationToken);
  }

  const cached = manifestsByInstallationId.get(installationId);
  if (cached && now() - cached.rebuiltAt < MANIFEST_TTL_MS) {
    return cached.context;
  }

  const context = await loadContext(installationToken);
  manifestsByInstallationId.set(installationId, { context, rebuiltAt: now() });
  return context;
}

export function applyWebhookEventToManifest(eventName, payload) {
  const installationId = payload?.installation?.id;
  if (!Number.isFinite(installationId)) {
    return "ignored";
  }

  if (eventName === "push") {
    const entry = manifestsByInstallationId.get(installationId);
    if (!entry) {
      return "ignored";
    }

    const fullName = payload?.repository?.full_name;
    const defaultBranch = payload?.repository?.default_branch;
    if (!fullName || !defaultBranch || payload?.ref !== `refs/heads/${defaultBranch}`) {
      return "ignored";
    }
    if (payload?.deleted === true) {
      // The default branch disappearing is not an incremental update — rebuild.
      manifestsByInstallationId.delete(installationId);
      return "dropped";
    }

    entry.context.remoteHeadsByRepoKey.set(normalizeRepositoryKey(fullName), {
      defaultBranchName: defaultBranch,
      defaultBranchHeadOid: typeof payload.after === "string" && payload.after ? payload.after : null,
    });
    return "updated";
  }

  if (MANIFEST_DROP_EVENTS.has(eventName)) {
    manifestsByInstallationId.delete(installationId);
    if (eventName === "installation" || eventName === "installation_repositories") {
      // Membership/uninstall changes invalidate cached auth state too, not just the
      // repo manifest.
      clearInstallationAccessCache(installationId);
      clearInstallationTokenCache(installationId);
    }
    return "dropped";
  }

  return "ignored";
}

export function resetInstallationManifestsForTests() {
  manifestsByInstallationId.clear();
}
