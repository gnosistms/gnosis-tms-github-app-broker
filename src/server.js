import express from "express";
import { pathToFileURL } from "node:url";

import { config } from "./config.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerGlossaryRoutes } from "./glossary-routes.js";
import { registerInstallRoutes } from "./install-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerTeamAiRoutes } from "./team-ai-routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      app: "gnosis-tms-github-app-broker",
    });
  });

  registerAuthRoutes(app, { renderRedirectPage });
  registerInstallRoutes(app, { renderRedirectPage });
  registerProjectRoutes(app);
  registerGlossaryRoutes(app);
  registerTeamAiRoutes(app);

  return app;
}

function renderRedirectPage(response, targetUrl, title, message, statusText) {
  const safeTargetUrl = JSON.stringify(targetUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7ecd5;
        --panel: #fffaf4;
        --text: #3f2610;
        --muted: #9c6a33;
        --accent: #ec9827;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top, rgba(236, 152, 39, 0.24), transparent 42%),
          linear-gradient(180deg, #f3d389 0%, var(--bg) 100%);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(100%, 760px);
        background: rgba(255, 250, 244, 0.96);
        border: 1px solid rgba(164, 112, 41, 0.14);
        border-radius: 28px;
        padding: 40px;
        box-shadow: 0 24px 60px rgba(131, 82, 22, 0.14);
      }

      .eyebrow {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.25rem, 5vw, 4rem);
        line-height: 0.95;
      }

      p {
        margin: 20px 0 0;
        font-size: 1.15rem;
        line-height: 1.65;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        margin-top: 28px;
        padding: 14px 18px;
        border-radius: 999px;
        background: rgba(236, 152, 39, 0.12);
        color: var(--muted);
        font-weight: 700;
      }

      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 0 0 rgba(236, 152, 39, 0.45);
        animation: pulse 1.4s infinite;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(236, 152, 39, 0.45); }
        70% { box-shadow: 0 0 0 14px rgba(236, 152, 39, 0); }
        100% { box-shadow: 0 0 0 0 rgba(236, 152, 39, 0); }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Gnosis TMS</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="status"><span class="dot"></span>${escapeHtml(statusText)}</div>
    </main>
    <script>
      window.setTimeout(() => {
        window.location.replace(${safeTargetUrl});
      }, 120);
    </script>
  </body>
</html>`;

  response.status(200).type("html").send(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`GitHub App broker listening on port ${config.port}`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer();
}
