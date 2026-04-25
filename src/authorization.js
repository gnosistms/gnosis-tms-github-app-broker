import { githubApi, createInstallationAccessToken } from "./github-app.js";
import {
  authHeaders,
  ensureAdminsTeamExists,
  ensureInstallationAccess,
  findExistingAdminTeam,
  getInstallationAccessDetails,
  listOrganizationAdminTeamMembers,
  normalizeGithubLogin,
} from "./installation-access.js";
import { ensureTeamMetadataRepo, inspectTeamMetadataRepo } from "./team-metadata-repo.js";

export async function configureOrganizationForGnosis({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  await githubApi(`/orgs/${orgLogin}`, {
    method: "PATCH",
    headers: authHeaders(brokerSession.accessToken),
    body: JSON.stringify({
      members_can_create_repositories: false,
      members_can_delete_repositories: false,
    }),
  });

  await ensureAdminsTeamExists({
    installationId,
    orgLogin,
    brokerSession,
  });

  await ensureTeamMetadataRepo({
    installationId,
    orgLogin,
  });
}

export async function inspectTeamMetadataForOrganization({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  return inspectTeamMetadataRepo({
    installationId,
    orgLogin,
  });
}

export async function listAuthorizedOrganizations(brokerSession) {
  const organizationsResponse = await githubApi("/user/orgs?per_page=100", {
    headers: {
      Authorization: `Bearer ${brokerSession.accessToken}`,
    },
  });
  const organizations = await organizationsResponse.json();

  const membershipsResponse = await githubApi("/user/memberships/orgs?state=active&per_page=100", {
    headers: {
      Authorization: `Bearer ${brokerSession.accessToken}`,
    },
  });
  const memberships = await membershipsResponse.json();

  const seen = new Set();
  const orgLogins = [];

  for (const organization of organizations) {
    if (organization?.login && !seen.has(organization.login)) {
      seen.add(organization.login);
      orgLogins.push(organization.login);
    }
  }

  for (const membership of memberships) {
    const login = membership?.organization?.login;
    if (membership?.state === "active" && login && !seen.has(login)) {
      seen.add(login);
      orgLogins.push(login);
    }
  }

  const details = await Promise.all(
    orgLogins.map(async (orgLogin) => {
      const response = await githubApi(`/orgs/${orgLogin}`, {
        headers: {
          Authorization: `Bearer ${brokerSession.accessToken}`,
        },
      });
      const payload = await response.json();
      return {
        login: payload.login,
        name: payload.name || null,
        description: payload.description || null,
        createdAt: payload.created_at || null,
        avatarUrl: payload.avatar_url || null,
        htmlUrl: payload.html_url || null,
      };
    }),
  );

  return details;
}

export async function listAccessibleInstallations(brokerSession) {
  const response = await githubApi("/user/installations?per_page=100", {
    headers: {
      Authorization: `Bearer ${brokerSession.accessToken}`,
    },
  });
  const payload = await response.json();
  const installations = Array.isArray(payload.installations) ? payload.installations : [];

  const results = await Promise.allSettled(
    installations.map((installation) =>
      getInstallationAccessDetails({
        installationId: installation.id,
        brokerSession,
        installationSummary: installation,
      }),
    ),
  );

  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
}

export async function listInstallationMembers(installationId, orgLogin, brokerSession) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  const installationToken = await createInstallationAccessToken(installationId);
  const headers = {
    Authorization: `Bearer ${installationToken}`,
  };
  const [membersResponse, adminMembersResponse] = await Promise.all([
    githubApi(`/orgs/${orgLogin}/members?per_page=100`, { headers }),
    githubApi(`/orgs/${orgLogin}/members?role=admin&per_page=100`, { headers }),
  ]);
  const payload = await membersResponse.json();
  const adminPayload = await adminMembersResponse.json();
  const adminTeamMemberLogins = await listOrganizationAdminTeamMembers(orgLogin, installationToken);
  const adminLogins = new Set(
    (Array.isArray(adminPayload) ? adminPayload : [])
      .map((member) => String(member?.login || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return (Array.isArray(payload) ? payload : []).map((member) => ({
    login: member.login,
    avatarUrl: member.avatar_url || null,
    htmlUrl: member.html_url || null,
    role: adminLogins.has(String(member?.login || "").trim().toLowerCase())
      ? "owner"
      : adminTeamMemberLogins.has(normalizeGithubLogin(member?.login))
        ? "admin"
        : "member",
  }));
}

export async function searchGithubUsersForInstallation(installationId, query, brokerSession) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const normalizedSearch = normalizedQuery.toLowerCase();
  const searchResponse = await githubApi(
    `/search/users?q=${encodeURIComponent(normalizedQuery)}+type:user&per_page=30`,
    {
      headers: {
        Authorization: `Bearer ${brokerSession.accessToken}`,
      },
    },
  );
  const searchPayload = await searchResponse.json();
  const items = Array.isArray(searchPayload.items) ? searchPayload.items : [];

  const details = await Promise.all(
    items.slice(0, 30).map(async (item, index) => {
      const userResponse = await githubApi(`/users/${item.login}`, {
        headers: {
          Authorization: `Bearer ${brokerSession.accessToken}`,
        },
      });
      const userPayload = await userResponse.json();
      const login = String(item.login || "").trim();
      const name = userPayload.name ? String(userPayload.name).trim() : "";
      const normalizedLogin = login.toLowerCase();
      const normalizedName = name.toLowerCase();
      const exactMatch =
        normalizedLogin === normalizedSearch || normalizedName === normalizedSearch;
      const substringMatch =
        !exactMatch
        && (
          normalizedLogin.includes(normalizedSearch)
          || normalizedName.includes(normalizedSearch)
        );

      return {
        id: item.id,
        login,
        name: name || null,
        avatarUrl: item.avatar_url || null,
        htmlUrl: item.html_url || null,
        __rankGroup: exactMatch ? 0 : substringMatch ? 1 : 2,
        __searchIndex: index,
      };
    }),
  );

  return details
    .sort((left, right) => left.__rankGroup - right.__rankGroup || left.__searchIndex - right.__searchIndex)
    .map(({ __rankGroup, __searchIndex, ...detail }) => detail);
}

export async function inviteUserToOrganizationForInstallation({
  installationId,
  orgLogin,
  inviteeId,
  inviteeLogin,
  inviteeEmail,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  let resolvedInviteeId = inviteeId ?? null;
  const normalizedLogin = String(inviteeLogin || "").trim();
  const normalizedEmail = String(inviteeEmail || "").trim();

  if (!resolvedInviteeId && normalizedLogin) {
    const userResponse = await githubApi(`/users/${normalizedLogin}`, {
      headers: {
        Authorization: `Bearer ${brokerSession.accessToken}`,
      },
    });
    const userPayload = await userResponse.json();
    resolvedInviteeId = userPayload.id || null;
  }

  if (!resolvedInviteeId && !normalizedEmail) {
    throw new Error("Provide a GitHub username or email to invite.");
  }

  const response = await githubApi(`/orgs/${orgLogin}/invitations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${brokerSession.accessToken}`,
    },
    body: JSON.stringify({
      ...(resolvedInviteeId ? { invitee_id: resolvedInviteeId } : {}),
      ...(!resolvedInviteeId && normalizedEmail ? { email: normalizedEmail } : {}),
      role: "direct_member",
    }),
  });
  const payload = await response.json();

  return {
    id: payload.id,
    login: payload.login || normalizedLogin || null,
    email: payload.email || normalizedEmail || null,
  };
}

export async function addOrganizationAdminForInstallation({
  installationId,
  orgLogin,
  username,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const adminTeam = await ensureAdminsTeamExists({
    installationId,
    orgLogin,
    brokerSession,
  });
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) {
    throw new Error("Provide a GitHub username to make admin.");
  }

  await githubApi(`/orgs/${orgLogin}/teams/${adminTeam.slug}/memberships/${normalizedUsername}`, {
    method: "PUT",
    headers: authHeaders(brokerSession.accessToken),
    body: JSON.stringify({
      role: "member",
    }),
  });
}

export async function removeOrganizationAdminForInstallation({
  installationId,
  orgLogin,
  username,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const existingTeam = await findExistingAdminTeam(orgLogin, brokerSession.accessToken);
  if (!existingTeam?.slug) {
    return;
  }

  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) {
    throw new Error("Provide a GitHub username to revoke admin.");
  }

  await githubApi(`/orgs/${orgLogin}/teams/${existingTeam.slug}/memberships/${normalizedUsername}`, {
    method: "DELETE",
    headers: authHeaders(brokerSession.accessToken),
  });
}

export async function promoteOrganizationOwnerForInstallation({
  installationId,
  orgLogin,
  username,
  brokerSession,
}) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) {
    throw new Error("Provide a GitHub username to make owner.");
  }

  if (normalizeGithubLogin(normalizedUsername) === normalizeGithubLogin(brokerSession.user?.login)) {
    throw new Error("You are already an owner of this team.");
  }

  const membershipResponse = await githubApi(
    `/orgs/${orgLogin}/memberships/${normalizedUsername}`,
    {
      headers: authHeaders(brokerSession.accessToken),
    },
  );
  const membership = await membershipResponse.json();
  if (membership?.state !== "active") {
    throw new Error(`@${normalizedUsername} is not an active member of this team.`);
  }

  if (membership?.role === "admin") {
    return;
  }

  await githubApi(`/orgs/${orgLogin}/memberships/${normalizedUsername}`, {
    method: "PUT",
    headers: authHeaders(brokerSession.accessToken),
    body: JSON.stringify({
      role: "admin",
    }),
  });
}
