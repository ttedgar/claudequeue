#!/usr/bin/env node
import { Command } from "commander";
import path from "path";
import { addRepo, getConfig, getActiveRepo } from "./config.js";
import { writeQueueTemplate } from "./queue.js";
import { setupClaudeSettings } from "./mcp.js";
import { startUIServer } from "./ui/server.js";
import { scheduler } from "./scheduler.js";

const program = new Command();

program
  .name("claudequeue")
  .description("Schedule and queue autonomous Claude Code tasks")
  .version("1.0.0");

// start — starts UI + MCP server + optional scheduler
program
  .command("start")
  .description("Start the claudequeue UI server and MCP server")
  .option("-p, --port <port>", "UI port (default: 3141)")
  .option("--no-ui", "Skip opening the browser")
  .action(async (opts) => {
    const config = getConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.ui.port;

    console.log("Starting claudequeue...");
    startUIServer(port);

    // Print URL
    console.log(`Open http://localhost:${port} in your browser`);
    console.log("Press Ctrl+C to stop\n");

    // Keep process alive
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      scheduler.stop();
      process.exit(0);
    });
  });

// setup — configure Claude Code MCP integration
program
  .command("setup")
  .description("Configure Claude Code to use claudequeue MCP server")
  .action(() => {
    try {
      setupClaudeSettings();
      console.log("\nSetup complete. Restart Claude Code to activate the MCP server.");
    } catch (err: unknown) {
      console.error(`Setup failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// add — register a repo
program
  .command("add <path>")
  .description("Register a repo with claudequeue")
  .action((repoPath: string) => {
    try {
      const repo = addRepo(repoPath);
      console.log(`✓ Registered repo: ${repo.name} (${repo.path})`);
      console.log(`  ID: ${repo.id}`);
      console.log(`\nRun \`claudequeue init\` inside the repo to create queue.md`);
    } catch (err: unknown) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// init — create queue.md in cwd
program
  .command("init")
  .description("Create a queue.md task file in the current directory")
  .action(async () => {
    const cwd = process.cwd();
    const queuePath = path.join(cwd, "queue.md");
    const { default: fs } = await import("fs");

    if (fs.existsSync(queuePath)) {
      console.log(`queue.md already exists at ${queuePath}`);
      return;
    }
    writeQueueTemplate(cwd);
    console.log(`✓ Created queue.md at ${queuePath}`);
    console.log(`\nEdit queue.md to add your tasks, then run \`claudequeue start\``);
  });

// doctor — check system health
program
  .command("doctor")
  .description("Check claudequeue configuration and dependencies")
  .action(async () => {
    const { execSync } = await import("child_process");
    const fs = await import("fs").then(m => m.default);
    const os = await import("os").then(m => m.default);
    const path = await import("path").then(m => m.default);

    let allGood = true;

    // 1. claude CLI on PATH
    try {
      execSync("claude --version", { stdio: "pipe" });
      console.log("✓ claude CLI found on PATH");
    } catch {
      console.log("✗ claude CLI not found — install it from https://claude.ai/code");
      allGood = false;
    }

    // 2. config.json exists
    const configPath = path.join(os.homedir(), ".claudequeue", "config.json");
    if (fs.existsSync(configPath)) {
      console.log(`✓ config.json found at ${configPath}`);
    } else {
      console.log(`✗ config.json not found — run \`claudequeue add <path>\` to create it`);
      allGood = false;
    }

    // 3. MCP entry in settings.json
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings?.mcpServers?.claudequeue) {
        console.log(`✓ MCP server entry found in ${settingsPath}`);
      } else {
        console.log(`✗ MCP server entry missing — run \`claudequeue setup\``);
        allGood = false;
      }
    } else {
      console.log(`✗ ~/.claude/settings.json not found — run \`claudequeue setup\``);
      allGood = false;
    }

    // 4. Active repo
    const repo = getActiveRepo();
    if (repo) {
      console.log(`✓ Active repo: ${repo.name} (${repo.path})`);
    } else {
      console.log(`✗ No active repo — run \`claudequeue add <path>\``);
      allGood = false;
    }

    if (allGood) {
      console.log("\n✓ Everything looks good!");
    } else {
      console.log("\nSome issues need attention (see above)");
      process.exit(1);
    }
  });

program.parse();
