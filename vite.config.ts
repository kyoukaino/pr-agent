import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    dts: true,
    format: ["esm"],
    clean: true,
    // The dashboard server reads ui.html next to the bundle; ship it with the CLI.
    copy: [{ from: "src/dashboard/ui.html", to: "dist" }],
  },
  fmt: {
    // Benchmark outputs are generated data, not source.
    ignorePatterns: ["bench/results/**", "bench/.cache/**"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "bench/**/*.test.ts"],
    testTimeout: 30000,
  },
});
