import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it, expect } from "vite-plus/test";
import { fetchQuickTunnelHostname, webhookUrlFor } from "./tunnel.js";

describe("quick tunnel hostname", () => {
  let hostname = "";
  let base = "";
  const server = http.createServer((req, res) => {
    if (req.url !== "/quicktunnel") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hostname }));
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("reads the hostname from cloudflared's metrics server", async () => {
    hostname = "abc-def.trycloudflare.com";
    expect(await fetchQuickTunnelHostname(base)).toBe("abc-def.trycloudflare.com");
    expect(webhookUrlFor("abc-def.trycloudflare.com")).toBe(
      "https://abc-def.trycloudflare.com/webhook",
    );
  });

  it("returns undefined before the tunnel has connected", async () => {
    hostname = "";
    expect(await fetchQuickTunnelHostname(base)).toBeUndefined();
  });
});
