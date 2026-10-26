#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pc from "picocolors";
import { BASE_MOUNT, PRAgent, loadConfig, oldPathsOf, parseGitDiff } from "./index.js";
import { gitDiff, hasCommit, writeRevisionFiles } from "./domain/git-snapshot.js";

const program = new Command();

program
  .name("pr-agent")
  .description("Autonomous Agentic Code Review PR Agent powered by DeepSeek & OpenTelemetry")
  .version("0.1.0");

program
  .command("review")
  .description("Review a pull request or git diff and output GitHub-compatible review payload")
  .option("-o, --owner <owner>", "GitHub repository owner", "my-org")
  .option("-r, --repo <repo>", "GitHub repository name", "my-repo")
  .option("-p, --pr <number>", "Pull request number", "1")
  .option("-c, --commit <sha>", "Target commit SHA")
  .option("-d, --diff <file>", "Path to git diff file")
  .option("--git", "Automatically extract diff from local git (git diff HEAD~1..HEAD)")
  .option("-m, --model <name>", "DeepSeek model (deepseek-flash, deepseek-v4-pro)")
  .option(
    "--protocol <protocol>",
    "Wire protocol (openai-completions, anthropic-messages, openai-responses)",
  )
  .option("--config <path>", "Explicit path to pr-agent config file (e.g. pr-agent.config.ts)")
  .option("-t, --temperature <number>", "Sampling temperature (default: 0.1)")
  .option("-b, --background <text>", "Requirement/business intent background")
  .option("--max-cost <usd>", "Spending cap for the review in USD (default: 1)")
  .option("--resume <runId>", "Resume an interrupted review session from checkpoint")
  .option("--publish", "Directly post review comments to GitHub (requires GITHUB_TOKEN)")
  .option("--json", "Output pure JSON review payload to stdout")
  .action(async (opts) => {
    try {
      // 1. Resolve multi-tier configuration
      const { config, configFile } = await loadConfig({
        configFile: opts.config,
        overrides: {
          protocol: opts.protocol,
          model: opts.model,
          temperature: opts.temperature !== undefined ? Number(opts.temperature) : undefined,
          budget: opts.maxCost !== undefined ? { maxCostUsd: Number(opts.maxCost) } : undefined,
        },
      });

      let rawDiff = "";
      // Revision the diff starts from (--git): its files are mounted as @base.
      let baseRev: string | undefined;
      if (opts.diff) {
        if (!fs.existsSync(opts.diff)) {
          console.error(pc.red(`Diff file not found: ${opts.diff}`));
          process.exit(1);
        }
        rawDiff = fs.readFileSync(opts.diff, "utf-8");
      } else if (opts.git) {
        baseRev = (await hasCommit(process.cwd(), "HEAD~1")) ? "HEAD~1" : "HEAD";
        rawDiff = await gitDiff(process.cwd(), baseRev, baseRev === "HEAD" ? undefined : "HEAD");
      } else {
        console.error(pc.red("Error: Must specify either --diff <file> or --git"));
        process.exit(1);
      }

      if (!rawDiff.trim()) {
        console.log(pc.yellow("No diff changes detected. Nothing to review."));
        process.exit(0);
      }

      let commitId = opts.commit;
      if (!commitId) {
        try {
          commitId = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
        } catch {
          commitId = "0000000000000000000000000000000000000000";
        }
      }

      if (!opts.json) {
        console.log(
          pc.cyan(`\n[PR-Agent] Initiating review for ${opts.owner}/${opts.repo}#${opts.pr}...`),
        );
        if (configFile) {
          console.log(pc.gray(`Config: loaded from ${configFile}`));
        }
        console.log(pc.magenta(`Model:  ${pc.bold(config.model)}`));
        console.log(pc.gray(`Commit: ${commitId}`));
      }

      const mounts: Record<string, string> = {};
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pr-agent-cli-"));
      let payload;
      try {
        if (baseRev) {
          mounts[BASE_MOUNT] = path.join(scratch, "base");
          const oldPaths = oldPathsOf(parseGitDiff(rawDiff).files);
          await writeRevisionFiles(process.cwd(), baseRev, oldPaths, mounts[BASE_MOUNT]);
        }
        const agent = new PRAgent(config);
        payload = await agent.reviewPR({
          owner: opts.owner,
          repo: opts.repo,
          pull_number: Number(opts.pr),
          commit_id: commitId,
          rawDiff,
          mounts,
          background: opts.background,
          publishToGitHub: opts.publish,
          resumeRunId: opts.resume,
        });
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.green(`\n[PR-Agent] Review Completed! Event: ${pc.bold(payload.event)}`));
        console.log(pc.cyan(`Comments generated: ${payload.comments.length}`));
        console.log(`\n${payload.body}`);

        for (const c of payload.comments) {
          const loc = c.line ? `:${c.line}` : "";
          console.log(pc.yellow(`\n--- [Comment on ${c.path}${loc}] ---`));
          console.log(c.body);
        }
      }
    } catch (err) {
      console.error(pc.red(`\n[PR-Agent Error] ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("server")
  .description("Start the private single-tenant GitHub App Webhook receiver & BullMQ Worker daemon")
  .action(async () => {
    try {
      const { startGitHubApp } = await import("./github-app/index.js");
      await startGitHubApp();
    } catch (err) {
      console.error(pc.red(`\n[Server Startup Error] ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("view")
  .description("Launch built-in local observability & review dashboard powered by SQLite")
  .option("-p, --port <port>", "Port for the dashboard web server", "6007")
  .option("-h, --host <host>", "Host address to bind to", "127.0.0.1")
  .option("--db <path>", "Custom path to traces.db")
  .action(async (opts) => {
    try {
      const { startDashboardServer } = await import("./dashboard/server.js");
      const port = Number(opts.port) || 6007;
      const host = opts.host || "127.0.0.1";
      const { url } = startDashboardServer({
        port,
        host,
        dbPath: opts.db,
      });

      console.log(pc.bold(pc.green("\n=== PR-Agent Observability Hub (SQLite Native) ===")));
      console.log(pc.cyan(`Dashboard available at: ${pc.bold(url)}`));
      console.log(pc.gray(`Connected to local SQLite: ${opts.db || ".pr-agent/traces.db"}`));
      console.log(pc.gray("Press Ctrl+C to stop.\n"));
    } catch (err) {
      console.error(pc.red(`\n[Dashboard Error] ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
