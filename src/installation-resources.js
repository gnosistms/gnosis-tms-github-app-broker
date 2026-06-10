// Combined listing of every gnosis resource type in an installation. One access check,
// one installation token, one repository enumeration (the expensive part) — instead of
// the three separate listing endpoints each re-running the same prelude. The legacy
// per-type endpoints remain for older app versions.
import { createHash } from "node:crypto";

import { ensureInstallationAccess } from "./installation-access.js";
import { createInstallationAccessToken } from "./github-app.js";
import { getInstallationRepositoryContext } from "./installation-manifest.js";
import { assembleGnosisProjects } from "./project-repos.js";
import { assembleGnosisGlossaries } from "./glossary-repos.js";
import { assembleGnosisQaLists } from "./qa-list-repos.js";

function sortedByFullName(resources) {
  return [...resources].sort((left, right) =>
    String(left?.fullName || "").localeCompare(String(right?.fullName || ""))
  );
}

// Equal digests mean the resource world (repo set, head OIDs, titles, lifecycle) is
// unchanged since the previous listing, so clients can skip downstream refresh work.
export function computeResourceListingDigest({ projects, glossaries, qaLists }) {
  const stablePayload = JSON.stringify({
    projects: sortedByFullName(projects),
    glossaries: sortedByFullName(glossaries),
    qaLists: sortedByFullName(qaLists),
  });
  return createHash("sha256").update(stablePayload).digest("hex");
}

export async function listGnosisResourcesForInstallation(installationId, brokerSession) {
  // The access verdict is computed to authorize this request anyway — return it so the
  // app gets capabilities with the data instead of paying a separate blocking call.
  const access = await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });
  const installationToken = await createInstallationAccessToken(installationId);
  const context = await getInstallationRepositoryContext(installationId, installationToken);

  const projects = await assembleGnosisProjects({ installationId, installationToken, context });
  const glossaries = assembleGnosisGlossaries(context);
  const qaLists = assembleGnosisQaLists(context);

  return {
    projects,
    glossaries,
    qaLists,
    // The digest intentionally excludes access: capability changes must not look like
    // resource-list changes.
    digest: computeResourceListingDigest({ projects, glossaries, qaLists }),
    access,
  };
}
