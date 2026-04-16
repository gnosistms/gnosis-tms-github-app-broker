import crypto from "node:crypto";

import { config } from "./config.js";

export const TEAM_AI_WRAPPED_KEY_ALGORITHM = "rsa-oaep-sha256-v1";

function normalizePem(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\\n/g, "\n")
    : "";
}

function teamAiBrokerPrivateKeyPem() {
  const pem = normalizePem(config.teamAiBrokerPrivateKey);
  if (!pem) {
    throw new Error("TEAM_AI_BROKER_PRIVATE_KEY is not configured on the broker.");
  }
  return pem;
}

function resolvedBrokerPublicKeyPem() {
  const configuredPublicKey = normalizePem(config.teamAiBrokerPublicKey);
  if (configuredPublicKey) {
    return configuredPublicKey;
  }

  return crypto
    .createPublicKey(teamAiBrokerPrivateKeyPem())
    .export({ type: "spki", format: "pem" })
    .trim()
    .toString();
}

function ensureSupportedWrappedKey(wrappedKey) {
  if (!wrappedKey || typeof wrappedKey !== "object" || Array.isArray(wrappedKey)) {
    throw new Error("wrappedKey must be an object.");
  }

  const algorithm = String(wrappedKey.algorithm || "").trim();
  if (algorithm !== TEAM_AI_WRAPPED_KEY_ALGORITHM) {
    throw new Error(`Unsupported wrapped key algorithm '${algorithm || "unknown"}'.`);
  }

  const ciphertext = String(wrappedKey.ciphertext || "").trim();
  if (!ciphertext) {
    throw new Error("wrappedKey.ciphertext is required.");
  }

  return {
    algorithm,
    ciphertext,
  };
}

function bufferFromBase64(value, label) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new Error(`${label} must be valid base64.`);
  }
}

function ensurePublicKeyPem(publicKeyPem) {
  const normalized = normalizePem(publicKeyPem);
  if (!normalized) {
    throw new Error("memberPublicKeyPem is required.");
  }

  try {
    crypto.createPublicKey(normalized);
  } catch {
    throw new Error("memberPublicKeyPem is not a valid PEM public key.");
  }

  return normalized;
}

export function getTeamAiBrokerPublicKeyPayload() {
  return {
    algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
    publicKeyPem: resolvedBrokerPublicKeyPem(),
  };
}

export function normalizeWrappedKeyRecord(wrappedKey) {
  return ensureSupportedWrappedKey(wrappedKey);
}

export function decryptWrappedKeyForBroker(wrappedKey) {
  const normalized = ensureSupportedWrappedKey(wrappedKey);
  const plaintext = crypto.privateDecrypt(
    {
      key: teamAiBrokerPrivateKeyPem(),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    bufferFromBase64(normalized.ciphertext, "wrappedKey.ciphertext"),
  ).toString("utf8");

  if (!plaintext.trim()) {
    throw new Error("The wrapped provider key decrypted to an empty value.");
  }

  return plaintext;
}

export function encryptWrappedKeyForPublicKey(plaintext, publicKeyPem) {
  const normalizedPlaintext = String(plaintext ?? "").trim();
  if (!normalizedPlaintext) {
    throw new Error("Cannot encrypt an empty provider key.");
  }

  const ciphertext = crypto.publicEncrypt(
    {
      key: ensurePublicKeyPem(publicKeyPem),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(normalizedPlaintext, "utf8"),
  );

  return {
    algorithm: TEAM_AI_WRAPPED_KEY_ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
  };
}
