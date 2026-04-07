import crypto from "node:crypto";

import { config } from "./config.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * config.brokerSessionTtlDays;
const SESSION_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function sessionKey() {
  return crypto
    .createHash("sha256")
    .update(config.brokerStateSecret)
    .digest()
    .subarray(0, KEY_BYTES);
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

export function createBrokerSession(payload) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(SESSION_ALGORITHM, sessionKey(), iv);
  const session = {
    ...payload,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  const plaintext = Buffer.from(JSON.stringify(session), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    encode(iv),
    encode(ciphertext),
    encode(authTag),
  ].join(".");
}

export function getBrokerSession(token) {
  try {
    const [version, ivPart, ciphertextPart, authTagPart] = String(token || "").split(".");
    if (version !== "v1" || !ivPart || !ciphertextPart || !authTagPart) {
      return null;
    }

    const decipher = crypto.createDecipheriv(
      SESSION_ALGORITHM,
      sessionKey(),
      decode(ivPart),
    );
    decipher.setAuthTag(decode(authTagPart));

    const plaintext = Buffer.concat([
      decipher.update(decode(ciphertextPart)),
      decipher.final(),
    ]).toString("utf8");
    const session = JSON.parse(plaintext);

    if (!session?.accessToken || !session?.user?.login) {
      return null;
    }

    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

export function destroyBrokerSession(_token) {
  // Broker sessions are encrypted, self-contained tokens. Logout is handled by
  // removing the token from the client, so there is no server-side session row
  // to delete here.
}
