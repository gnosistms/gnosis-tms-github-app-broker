import crypto from "node:crypto";

import { config } from "./config.js";

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", config.brokerStateSecret)
    .update(payload)
    .digest("base64url");
}

export function encodeInstallState(value) {
  const payload = base64UrlEncode(JSON.stringify(value));
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

export function decodeInstallState(value) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) {
    throw new Error("Missing or invalid install state.");
  }

  const expectedSignature = signPayload(payload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error("Install state signature did not match.");
  }

  return JSON.parse(base64UrlDecode(payload));
}
