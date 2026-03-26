import crypto from "node:crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const sessions = new Map();

export function createBrokerSession(payload) {
  cleanupExpiredSessions();

  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    ...payload,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function getBrokerSession(token) {
  cleanupExpiredSessions();
  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

export function destroyBrokerSession(token) {
  sessions.delete(token);
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}
