import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteTraceStore } from "../telemetry/sqlite-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
}

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The UI is served from this origin, so no CORS headers are sent: other sites must not be able to read
 * review data (diffs, findings, tool output) from the local dashboard. The Host check blocks
 * DNS-rebinding requests that would otherwise look same-origin.
 */
export function isAllowedHost(hostHeader: string | undefined, bindHost: string): boolean {
  const hostName = (hostHeader || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return ALLOWED_HOSTS.has(hostName) || hostName === bindHost;
}

export function startDashboardServer(options: DashboardServerOptions = {}): {
  server: http.Server;
  url: string;
} {
  const port = options.port || 6007;
  const host = options.host || "127.0.0.1";
  const store = new SqliteTraceStore(options.dbPath);

  // Auto-sync traces and sessions from disk on startup
  try {
    store.syncFromDisk();
  } catch (err) {
    console.error("[Dashboard] Error syncing initial traces:", err);
  }

  // Load UI HTML
  const htmlPath = path.join(__dirname, "ui.html");
  let htmlContent = "";
  if (fs.existsSync(htmlPath)) {
    htmlContent = fs.readFileSync(htmlPath, "utf-8");
  } else {
    // Fallback if running from dist or bundled
    const rootHtmlPath = path.join(process.cwd(), "src", "dashboard", "ui.html");
    if (fs.existsSync(rootHtmlPath)) {
      htmlContent = fs.readFileSync(rootHtmlPath, "utf-8");
    }
  }

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (!isAllowedHost(req.headers.host, host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden host");
      return;
    }

    // 1. Serve UI
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlContent);
      return;
    }

    // 2. GET /api/metrics
    if (pathname === "/api/metrics" && req.method === "GET") {
      const metrics = store.getGlobalMetrics();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
      return;
    }

    // 3. GET /api/reviews
    if (pathname === "/api/reviews" && req.method === "GET") {
      const reviews = store.getReviews();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reviews));
      return;
    }

    // 4. GET /api/reviews/:id
    if (pathname.startsWith("/api/reviews/") && req.method === "GET") {
      const id = pathname.replace("/api/reviews/", "").trim();
      const details = store.getReviewById(id);
      if (!details) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Review ${id} not found` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(details));
      return;
    }

    // 5. POST /api/sync
    if (pathname === "/api/sync" && req.method === "POST") {
      const imported = store.syncFromDisk();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, imported }));
      return;
    }

    // 404 Not Found
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, host, () => {
    // Started
  });

  const url = `http://${host}:${port}`;
  return { server, url };
}
