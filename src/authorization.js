import { createInstallationAccessToken, getInstallation, githubApi } from "./github-app.js";

async function loadOrganizationMembership(orgLogin, userAccessToken) {
  const response = await githubApi(`/user/memberships/orgs/${orgLogin}`, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });
  return response.json();
}

export async function getInstallationAccessDetails({
  installationId,
  brokerSession,
}) {
  const installation = await getInstallation(installationId);

  if (installation.accountType === "User") {
    const isSelf = installation.accountLogin === brokerSession.user.login;
    return {
      ...installation,
      membershipState: isSelf ? "active" : "inactive",
      membershipRole: isSelf ? "admin" : "member",
      canDelete: isSelf,
      canManageProjects: isSelf,
      canLeave: false,
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

  return {
    ...installation,
    accountName: orgPayload.name || null,
    description: orgPayload.description || null,
    membershipState: membership.state || "unknown",
    membershipRole: membership.role || "member",
    canDelete: membership.state === "active" && membership.role === "admin",
    canManageProjects: membership.state === "active" && membership.role === "admin",
    canLeave: membership.state === "active",
  };
}

export async function ensureInstallationAccess({
  installationId,
  brokerSession,
  requireAdmin = false,
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

  if (requireAdmin && installation.membershipRole !== "admin") {
    throw new Error(`You need admin access in @${installation.accountLogin} for this action.`);
  }

  return installation;
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

export async function listInstallationMembers(installationId, orgLogin, brokerSession) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  const installationToken = await createInstallationAccessToken(installationId);
  const response = await githubApi(`/orgs/${orgLogin}/members?per_page=100`, {
    headers: {
      Authorization: `Bearer ${installationToken}`,
    },
  });
  const payload = await response.json();
  return payload.map((member) => ({
    login: member.login,
    avatarUrl: member.avatar_url || null,
    htmlUrl: member.html_url || null,
  }));
}

export async function searchGithubUsersForInstallation(installationId, query, brokerSession) {
  await ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: true,
  });

  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const searchResponse = await githubApi(
    `/search/users?q=${encodeURIComponent(normalizedQuery)}+in:login+in:fullname+type:user&per_page=6`,
    {
      headers: {
        Authorization: `Bearer ${brokerSession.accessToken}`,
      },
    },
  );
  const searchPayload = await searchResponse.json();
  const items = Array.isArray(searchPayload.items) ? searchPayload.items : [];

  const details = await Promise.all(
    items.slice(0, 6).map(async (item) => {
      const userResponse = await githubApi(`/users/${item.login}`, {
        headers: {
          Authorization: `Bearer ${brokerSession.accessToken}`,
        },
      });
      const userPayload = await userResponse.json();
      return {
        id: item.id,
        login: item.login,
        name: userPayload.name || null,
        avatarUrl: item.avatar_url || null,
        htmlUrl: item.html_url || null,
      };
    }),
  );

  return details;
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
    requireAdmin: true,
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
