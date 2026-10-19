import { describe, it, expect } from "vite-plus/test";
import { isAllowedHost } from "./server.js";

describe("dashboard Host check", () => {
  it("accepts loopback hosts with or without a port (regression: every request was rejected)", () => {
    expect(isAllowedHost("127.0.0.1:6007", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("localhost:6007", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("[::1]:6007", "127.0.0.1")).toBe(true);
    expect(isAllowedHost("localhost", "127.0.0.1")).toBe(true);
  });

  it("accepts the explicit bind host and rejects anything else (DNS rebinding)", () => {
    expect(isAllowedHost("192.168.1.5:6007", "192.168.1.5")).toBe(true);
    expect(isAllowedHost("evil.example:6007", "127.0.0.1")).toBe(false);
    expect(isAllowedHost(undefined, "127.0.0.1")).toBe(false);
  });
});
