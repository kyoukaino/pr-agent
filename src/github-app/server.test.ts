import * as crypto from "node:crypto";
import { describe, it, expect } from "vite-plus/test";
import { verifyWebhookSignature } from "./server.js";

describe("verifyWebhookSignature", () => {
  const body = Buffer.from('{"action":"opened"}');
  const good = `sha256=${crypto.createHmac("sha256", "s3cret").update(body).digest("hex")}`;

  it("accepts the correct signature", () => {
    expect(verifyWebhookSignature("s3cret", body, good)).toBe(true);
  });

  it("rejects wrong or malformed signatures without throwing", () => {
    expect(verifyWebhookSignature("s3cret", body, "sha256=abc")).toBe(false); // length mismatch used to throw
    expect(verifyWebhookSignature("other", body, good)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, undefined)).toBe(false);
  });
});
