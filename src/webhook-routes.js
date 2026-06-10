import crypto from "node:crypto";
import express from "express";

import { config } from "./config.js";
import {
  applyWebhookEventToManifest,
  installationManifestEnabled,
} from "./installation-manifest.js";

export function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!secret || typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signatureHeader);
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted);
}

export function registerWebhookRoutes(app) {
  app.post(
    "/webhooks/github",
    // Raw body: the HMAC signature covers the exact bytes GitHub sent.
    express.raw({ type: "*/*", limit: "5mb" }),
    (request, response) => {
      if (!installationManifestEnabled()) {
        response.status(503).json({ error: "GITHUB_APP_WEBHOOK_SECRET is not configured." });
        return;
      }

      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.get("x-hub-signature-256");
      if (!verifyWebhookSignature(config.githubAppWebhookSecret, rawBody, signature)) {
        response.status(401).json({ error: "Invalid webhook signature." });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        response.status(400).json({ error: "Webhook payload is not valid JSON." });
        return;
      }

      applyWebhookEventToManifest(request.get("x-github-event") || "", payload);
      response.status(204).end();
    },
  );
}
