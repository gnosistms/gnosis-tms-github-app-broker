import { ensureInstallationAccess } from "./installation-access.js";
import {
  decryptWrappedKeyForBroker,
  encryptWrappedKeyForPublicKey,
  getTeamAiBrokerPublicKeyPayload,
  normalizeWrappedKeyRecord,
} from "./team-ai-crypto.js";
import {
  getTeamAiSecretsRecord,
  getTeamAiSettingsRecord,
  putTeamAiSecretsRecord,
  putTeamAiSettingsRecord,
} from "./team-ai-metadata.js";

const TEAM_AI_PROVIDER_IDS = ["openai", "gemini", "claude", "deepseek"];

export const teamAiDependencies = {
  ensureInstallationAccess,
  decryptWrappedKeyForBroker,
  encryptWrappedKeyForPublicKey,
  getTeamAiBrokerPublicKeyPayload,
  normalizeWrappedKeyRecord,
  getTeamAiSecretsRecord,
  getTeamAiSettingsRecord,
  putTeamAiSecretsRecord,
  putTeamAiSettingsRecord,
};

function normalizeProviderId(providerId) {
  const normalized = String(providerId || "").trim().toLowerCase();
  if (!TEAM_AI_PROVIDER_IDS.includes(normalized)) {
    throw new Error(`Unsupported team AI provider '${providerId || ""}'.`);
  }
  return normalized;
}

function buildSecretsMetadata(record) {
  const providers = Object.fromEntries(
    TEAM_AI_PROVIDER_IDS.flatMap((providerId) => {
      const provider = record.providers?.[providerId];
      if (!provider?.brokerWrappedKey?.ciphertext) {
        return [];
      }

      return [[providerId, {
        configured: true,
        keyVersion: provider.keyVersion,
        algorithm: provider.brokerWrappedKey.algorithm,
      }]];
    }),
  );

  return {
    schemaVersion: record.schemaVersion,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    providers,
  };
}

export function getTeamAiBrokerPublicKey() {
  return teamAiDependencies.getTeamAiBrokerPublicKeyPayload();
}

export async function loadTeamAiSettingsForInstallation({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await teamAiDependencies.ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  return teamAiDependencies.getTeamAiSettingsRecord({
    installationId,
    orgLogin,
  });
}

export async function saveTeamAiSettingsForInstallation({
  installationId,
  orgLogin,
  actionPreferences,
  brokerSession,
}) {
  await teamAiDependencies.ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  return teamAiDependencies.putTeamAiSettingsRecord({
    installationId,
    orgLogin,
    actionPreferences,
    actorLogin: brokerSession?.user?.login ?? null,
  });
}

export async function loadTeamAiSecretsMetadataForInstallation({
  installationId,
  orgLogin,
  brokerSession,
}) {
  await teamAiDependencies.ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  return buildSecretsMetadata(await teamAiDependencies.getTeamAiSecretsRecord({
    installationId,
    orgLogin,
  }));
}

export async function saveTeamAiProviderSecretForInstallation({
  installationId,
  orgLogin,
  providerId,
  wrappedKey,
  clear = false,
  brokerSession,
}) {
  await teamAiDependencies.ensureInstallationAccess({
    installationId,
    brokerSession,
    requireOwner: true,
  });

  const normalizedProviderId = normalizeProviderId(providerId);
  const currentRecord = await teamAiDependencies.getTeamAiSecretsRecord({
    installationId,
    orgLogin,
  });
  const nextProviders = {
    ...currentRecord.providers,
  };

  if (clear === true) {
    nextProviders[normalizedProviderId] = null;
  } else {
    const normalizedWrappedKey = teamAiDependencies.normalizeWrappedKeyRecord(wrappedKey);
    teamAiDependencies.decryptWrappedKeyForBroker(normalizedWrappedKey);

    const previousKeyVersion = Number.isInteger(currentRecord.providers[normalizedProviderId]?.keyVersion)
      ? currentRecord.providers[normalizedProviderId].keyVersion
      : 0;
    nextProviders[normalizedProviderId] = {
      keyVersion: previousKeyVersion + 1,
      rotationReason: "manual",
      brokerWrappedKey: normalizedWrappedKey,
    };
  }

  const nextRecord = await teamAiDependencies.putTeamAiSecretsRecord({
    installationId,
    orgLogin,
    actorLogin: brokerSession?.user?.login ?? null,
    record: {
      ...currentRecord,
      providers: nextProviders,
    },
  });

  return buildSecretsMetadata(nextRecord);
}

export async function issueTeamAiProviderSecretForInstallation({
  installationId,
  orgLogin,
  providerId,
  memberPublicKeyPem,
  brokerSession,
}) {
  await teamAiDependencies.ensureInstallationAccess({
    installationId,
    brokerSession,
    requireAdmin: false,
  });

  const normalizedProviderId = normalizeProviderId(providerId);
  const secretsRecord = await teamAiDependencies.getTeamAiSecretsRecord({
    installationId,
    orgLogin,
  });
  const providerRecord = secretsRecord.providers[normalizedProviderId];
  if (!providerRecord?.brokerWrappedKey?.ciphertext) {
    throw new Error(`This team has not configured a shared ${normalizedProviderId} key yet.`);
  }

  const plaintextKey = teamAiDependencies.decryptWrappedKeyForBroker(providerRecord.brokerWrappedKey);
  return {
    providerId: normalizedProviderId,
    keyVersion: providerRecord.keyVersion,
    wrappedKey: teamAiDependencies.encryptWrappedKeyForPublicKey(plaintextKey, memberPublicKeyPem),
  };
}
