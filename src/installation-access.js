import { config } from "./config.js";
import { createInstallationAccessToken, getInstallation, githubApi } from "./github-app.js";

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

export async function getInstallationAccessDetails({
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
      membershipRole: isSelf ? "admin" : "member",
      canDelete: isSelf,
      canManageMembers: isSelf,
      canManageProjects: isSelf,
      canLeave: false,
      permissions: {},
      appApprovalUrl: null,
      appRequestUrl: null,
    };
  }

  const membership = await loadOrganizationMembership(
    installation.accountLogin,
    brokerSession.accessToken,
  );
  const orgResponse = await githubApi(`/orgs/${installation.accountLogin}`, {
    headers: {
      Authorization: `Bearer ${brokerSession.accessToken}`,
    },
  });
  const orgPayload = await orgResponse.json();
  const installationToken = await createInstallationAccessToken(installationId);
  const adminTeamMemberLogins = await listAdminTeamMemberLogins(
    installation.accountLogin,
    installationToken,
  );
  const isOwner = membership.state === "active" && membership.role === "admin";
  const isAppAdmin =
    isOwner || adminTeamMemberLogins.has(normalizeLogin(brokerSession.user.login));

  return {
    ...installation,
    accountName: orgPayload.name || null,
    description: orgPayload.description || null,
    membershipState: membership.state || "unknown",
    membershipRole: membership.role || "member",
    canDelete: isOwner,
    canManageMembers: isOwner,
    canManageProjects: membership.state === "active" && isAppAdmin,
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
}) {
  const installation = await getInstallationAccessDetails({
    installationId,
    brokerSession,
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
