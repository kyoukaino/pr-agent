/**
 * Registers the pr-agent GitHub App through GitHub's App Manifest flow.
 *
 *   node scripts/create-github-app.ts --name pr-agent-yourname [--org your-org] [--out .env.github-app]
 *
 * Opens a local page that submits the manifest (permissions, events, webhook) to GitHub; after you
 * confirm in the browser, GitHub redirects back with a one-time code, which is exchanged for the App
 * ID, private key and webhook secret. Those are written as dotenv lines to --out (keep it secret).
 *
 * The webhook URL defaults to an unresolvable placeholder: with a quick tunnel the running service
 * sets the real URL itself (CLOUDFLARED_METRICS_URL); with a fixed hostname pass --webhook-url.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    org: { type: "string" },
    "webhook-url": { type: "string", default: "https://pr-agent.invalid/webhook" },
    homepage: { type: "string", default: "https://github.com" },
    out: { type: "string", default: ".env.github-app" },
  },
});
if (!args.name) {
  console.error("Usage: node scripts/create-github-app.ts --name <app-name> [--org <org>]");
  process.exit(1);
}
if (fs.existsSync(args.out)) {
  console.error(`${args.out} already exists; move it away or pass --out <file>.`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const newAppUrl = args.org
  ? `https://github.com/organizations/${encodeURIComponent(args.org)}/settings/apps/new`
  : "https://github.com/settings/apps/new";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  if (url.pathname === "/") {
    const manifest = {
      name: args.name,
      url: args.homepage,
      description: "Autonomous code review agent: reviews pull requests and posts inline comments.",
      public: false,
      redirect_url: `${base}/callback`,
      hook_attributes: { url: args["webhook-url"], active: true },
      default_events: ["pull_request"],
      default_permissions: {
        pull_requests: "write",
        contents: "read",
        metadata: "read",
        checks: "read",
        statuses: "read",
        actions: "read",
      },
    };
    const value = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Create GitHub App</title>
<form id="f" method="post" action="${newAppUrl}?state=${state}">
<input type="hidden" name="manifest" value="${value}">
<button>Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script>`);
    return;
  }

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Missing code or state mismatch.");
      return;
    }
    try {
      const resp = await fetch(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!resp.ok) throw new Error(`conversion failed: ${resp.status} ${await resp.text()}`);
      const app = (await resp.json()) as {
        id: number;
        slug: string;
        html_url: string;
        pem: string;
        webhook_secret: string | null;
      };
      if (!app.webhook_secret) throw new Error("GitHub returned no webhook secret");
      const lines = [
        `# GitHub App ${app.slug} (${app.html_url}), created ${new Date().toISOString()}`,
        `GITHUB_APP_ID=${app.id}`,
        `GITHUB_APP_PRIVATE_KEY="${app.pem.trim().replace(/\r?\n/g, "\\n")}"`,
        `GITHUB_WEBHOOK_SECRET="${app.webhook_secret}"`,
        "",
      ];
      fs.writeFileSync(args.out, lines.join("\n"), { mode: 0o600 });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Created ${app.slug}. Credentials saved locally; you can close this tab.`);
      console.log(`Created ${app.html_url}`);
      console.log(`Credentials written to ${args.out}`);
      console.log(`Install it on repositories: ${app.html_url}/installations/new`);
    } catch (err) {
      res.writeHead(500).end(String(err));
      console.error(String(err));
      process.exitCode = 1;
    }
    server.close();
    return;
  }

  res.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  console.log(`Open http://127.0.0.1:${port}/ in your browser to create the App.`);
});
