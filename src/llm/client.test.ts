import { describe, it, expect } from "vite-plus/test";
import { createLLMClient, DeepSeekLLMClient } from "./client.js";

describe("LLMClient factory & instantiation", () => {
  it("defaults to openai-completions protocol", () => {
    const client = createLLMClient({
      apiKey: "mock-key",
      model: "deepseek-flash",
    });

    expect(client.protocol).toBe("openai-completions");
    expect(client.model).toBe("deepseek-flash");
    expect(client.temperature).toBe(0.1);
  });

  it("creates anthropic-messages client with specified protocol", () => {
    const client = createLLMClient({
      protocol: "anthropic-messages",
      apiKey: "mock-key",
      model: "deepseek-flash",
    });

    expect(client.protocol).toBe("anthropic-messages");
  });

  it("creates openai-responses client with specified protocol", () => {
    const client = createLLMClient({
      protocol: "openai-responses",
      apiKey: "mock-key",
      model: "gpt-4o",
    });

    expect(client.protocol).toBe("openai-responses");
    expect(client.model).toBe("gpt-4o");
  });

  it("DeepSeekLLMClient maintains backward compatibility", () => {
    const client = new DeepSeekLLMClient({
      apiKey: "mock-key",
    });

    expect(client.protocol).toBe("openai-completions");
    expect(client.model).toBe("deepseek-flash");
  });

  it("throws when no API key is provided", () => {
    const origEnv = { ...process.env };
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => createLLMClient({})).toThrow(/API key is not set/);

    process.env = origEnv;
  });
});
