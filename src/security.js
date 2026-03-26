import { config } from "./config.js";
import { loadBrokerSessionFromHeader } from "./broker-auth.js";

export function ensureBrokerToken(request, response, next) {
  if (!config.brokerToken) {
    next();
    return;
  }

  const header = request.get("authorization") || "";
  const expected = `Bearer ${config.brokerToken}`;
  if (header !== expected) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

export function ensureBrokerSession(request, response, next) {
  const session = loadBrokerSessionFromHeader(request);
  if (!session) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  request.brokerSession = session;
  next();
}

export function ensureAllowedDesktopCallback(desktopRedirectUri) {
  let parsed;

  try {
    parsed = new URL(desktopRedirectUri);
  } catch {
    throw new Error("desktop_redirect_uri must be a valid URL.");
  }

  const normalized = parsed.toString();
  const isAllowed = config.allowedDesktopCallbackPrefixes.some((prefix) =>
    normalized.startsWith(prefix),
  );

  if (!isAllowed) {
    throw new Error("desktop_redirect_uri is not in the allowed callback list.");
  }

  return normalized;
}
