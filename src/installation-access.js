import { config } from "./config.js";
import { createInstallationAccessToken, getInstallation, githubApi } from "./github-app.js";
import { listMemberRoleMetadataRecords } from "./team-metadata-repo.js";

export const READ_ONLY_ROLE = "viewer";

function normalizeLogin(login) {
  return typeof login === "string" && login.trim()
    ? login.trim().toLowerCase()
    : "";
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function listOrganizationTeams(orgLogin, token) {
  const response = await githubApi(`/orgs/${orgLogin}/teams?per_page=100`, {
    headers: authHeaders(token),
  });
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function findAdminTeam(orgLogin, token) {
  const teams = await listOrganizationTeams(orgLogin, token);
  return teams.find((team) => normalizeLogin(team?.slug) === normalizeLogin(config.adminTeamSlug)) || null;
}

async function listAdminTeamMemberLogins(orgLogin, installationToken) {
  let adminTeam = null;
  try {
    adminTeam = await findAdminTeam(orgLogin, installationToken);
  } catch (error) {
    if (error?.githubStatus === 403 || error?.githubStatus === 404) {
      return new Set();
    }
    throw error;
  }
  if (!adminTeam?.slug) {
    return new Set();
  }

  try {
    const response = await githubApi(
      `/orgs/${orgLogin}/teams/${adminTeam.slug}/members?per_page=100`,
      {
        headers: authHeaders(installationToken),
      },
    );
    const payload = await response.json();
    return new Set(
      (Array.isArray(payload) ? payload : [])
        .map((member) => normalizeLogin(member?.login))
        .filter(Boolean),
    );
  } catch (error) {
    if (error?.githubStatus === 404) {
      return new Set();
    }
    throw error;
  }
}

async function loadOrganizationMembership(orgLogin, userAccessToken) {
  try {
    const response = await githubApi(`/user/memberships/orgs/${orgLogin}`, {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
      },
    });
    return response.json();
  } catch (error) {
    if (error?.githubStatus !== 404) {
      throw error;
    }

    const fallbackResponse = await githubApi("/user/memberships/orgs?state=active&per_page=100", {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
      },
    });
    const memberships = await fallbackResponse.json();
    const match = Array.isArray(memberships)
      ? memberships.find(
          (membership) => membership?.organization?.login === orgLogin,
        )
      : null;

    if (match) {
      return match;
    }

    throw error;
  }
}

export async function listViewerRoleLogins({ installationId, orgLogin }) {
  try {
    const records = await listMemberRoleMetadataRecords({ installationId, orgLogin });
    return new Set(records.map((record) => normalizeLogin(record.username)).filter(Boolean));
  } catch (error) {
    if (error?.githubStatus === 403 || error?.githubStatus === 404) {
      return new Set();
    }
    throw error;
  }
}

export function isReadOnlyInstallationAccess(installation) {
  return installation?.membershipRole === READ_ONLY_ROLE;
}

// The full access check is six sequential GitHub round trips (installation, membership,
// org, token, admin-team members, viewer roles) — ~4s that every authorized broker
// request used to pay. Verdicts are cached per (installation, user) with two freshness
// tiers: reads accept a verdict up to 30 minutes old (Hans accepted the staleness window
// explicitly, and the app shows a notice after member removal), while write-relevant
// checks — admin/owner/project-admin requirements and write-capable git token issuance —
// require a verdict no older than 5 minutes. Webhook installation events clear the cache.
const READ_ACCESS_MAX_AGE_MS = 30 * 60 * 1000;
const WRITE_ACCESS_MAX_AGE_MS = 5 * 60 * 1000;
const accessDetailsCache = new Map();

function accessDetailsCacheKey(installationId, brokerSession) {
  return `${installationId}:${normalizeLogin(brokerSession?.user?.login)}`;
}

export function clearInstallationAccessCache(installationId) {
  const prefix = `${installationId}:`;
  for (const key of accessDetailsCache.keys()) {
    if (key.startsWith(prefix)) {
      accessDetailsCache.delete(key);
    }
  }
}

export function resetInstallationAccessCacheForTests() {
  accessDetailsCache.clear();
}

export async function getInstallationAccessDetails({
  installationId,
  brokerSession,
  installationSummary = null,
  maxAgeMs = READ_ACCESS_MAX_AGE_MS,
}) {
  const cacheKey = accessDetailsCacheKey(installationId, brokerSession);
  const cached = accessDetailsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < Math.min(maxAgeMs, READ_ACCESS_MAX_AGE_MS)) {
    return cached.details;
  }

  const details = await loadInstallationAccessDetailsUncached({
    installationId,
    brokerSession,
    installationSummary,
  });
  accessDetailsCache.set(cacheKey, {
    details,
    fetchedAt: Date.now(),
  });
  return details;
}

async function loadInstallationAccessDetailsUncached({
  installationId,
  brokerSession,
  installationSummary = null,
}) {
  const installation = await getInstallation(installationId);
  const permissions =
    installation.accountType === "Organization"
      ? installation.permissions || installationSummary?.permissions || {}
      : {};
  const appApprovalUrl =
    installation.accountType === "Organization"
      ? installation.installationHtmlUrl
        || (installation.accountLogin
          ? `https://github.com/organizations/${installation.accountLogin}/settings/installations`
          : null)
      : null;
  const appRequestUrl =
    installation.accountType === "Organization"
    && installation.appSlug
    && installation.accountId
      ? `https://github.com/apps/${installation.appSlug}/installations/new?target_id=${installation.accountId}&target_type=${encodeURIComponent(installation.targetType || "Organization")}`
      : null;

  if (installation.accountType === "User") {
    const isSelf = installation.accountLogin === brokerSession.user.login;
    return {
      ...installation,
      membershipState: isSelf ? "active" : "inactive",
      membershipRole: isSelf ? "owner" : "translator",
      canDelete: isSelf,
      canManageMembers: isSelf,
      canManageProjects: isSelf,
      canLeave: false,
      permissions: {},
      appApprovalUrl: null,
      appRequestUrl: null,
    };
  }

  // These lookups are independent once the org login is known; running them
  // sequentially made every cold access check pay the sum of ~6 GitHub round trips
  // (~4s). Concurrently the wall cost is the slowest branch (~1 round trip, two for
  // the token -> admins-team chain when the token cache is cold).
  const [membership, orgPayload, adminTeamMemberLogins, viewerRoleLogins] =
    await Promise.all([
      loadOrganizationMembership(installation.accountLogin, brokerSession.accessToken),
      githubApi(`/orgs/${installation.accountLogin}`, {
        headers: {
          Authorization: `Bearer ${brokerSession.accessToken}`,
        },
      }).then((response) => response.json()),
      createInstallationAccessToken(installationId).then((installationToken) =>
        listAdminTeamMemberLogins(installation.accountLogin, installationToken)
      ),
      listViewerRoleLogins({
        installationId,
        orgLogin: installation.accountLogin,
      }),
    ]);
  const isOwner = membership.state === "active" && membership.role === "admin";
  const normalizedActorLogin = normalizeLogin(brokerSession.user.login);
  const isAppAdmin = isOwner || adminTeamMemberLogins.has(normalizedActorLogin);
  const isViewer = !isAppAdmin && viewerRoleLogins.has(normalizedActorLogin);

  return {
    ...installation,
    accountName: orgPayload.name || null,
    description: orgPayload.description || null,
    membershipState: membership.state || "unknown",
    membershipRole: isOwner
      ? "owner"
      : isAppAdmin
        ? "admin"
        : isViewer
          ? READ_ONLY_ROLE
          : "translator",
    canDelete: isOwner,
    canManageMembers: isOwner,
    canManageProjects: membership.state === "active" && isAppAdmin && !isViewer,
    canLeave: membership.state === "active",
    permissions,
    appApprovalUrl,
    appRequestUrl,
  };
}

export async function ensureInstallationAccess({
  installationId,
  brokerSession,
  requireAdmin = false,
  requireOwner = false,
  requireProjectAdmin = false,
  requireFreshAccess = false,
}) {
  // Write-relevant checks must not ride out the long read TTL: a demoted or removed
  // member may keep reading up to 30 minutes, but not acting.
  const writeRelevant =
    requireAdmin || requireOwner || requireProjectAdmin || requireFreshAccess;
  const installation = await getInstallationAccessDetails({
    installationId,
    brokerSession,
    maxAgeMs: writeRelevant ? WRITE_ACCESS_MAX_AGE_MS : READ_ACCESS_MAX_AGE_MS,
  });

  if (installation.accountType === "User") {
    if (installation.accountLogin !== brokerSession.user.login) {
      throw new Error("You are not allowed to access this user installation.");
    }

    return installation;
  }

  if (installation.membershipState !== "active") {
    throw new Error(`Your membership in @${installation.accountLogin} is not active.`);
  }

  if ((requireAdmin || requireOwner) && installation.canDelete !== true) {
    throw new Error(`You need admin access in @${installation.accountLogin} for this action.`);
  }

  if (requireProjectAdmin && installation.canManageProjects !== true) {
    throw new Error(`You do not have project admin access in @${installation.accountLogin}.`);
  }

  return installation;
}

export async function ensureAdminsTeamExists({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const existingTeam = await findAdminTeam(orgLogin, brokerSession.accessToken);
  if (existingTeam) {
    return existingTeam;
  }

  const response = await githubApi(`/orgs/${orgLogin}/teams`, {
    method: "POST",
    headers: authHeaders(brokerSession.accessToken),
    body: JSON.stringify({
      name: config.adminTeamSlug,
      privacy: "closed",
    }),
  });

  return response.json();
}

export async function findExistingAdminTeam(orgLogin, token) {
  return findAdminTeam(orgLogin, token);
}

export async function listOrganizationAdminTeamMembers(orgLogin, installationToken) {
  return listAdminTeamMemberLogins(orgLogin, installationToken);
}

export function normalizeGithubLogin(login) {
  return normalizeLogin(login);
}
