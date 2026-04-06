import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { parseTasks, updateTaskStatus, appendDecision } from "./queue.js";
import { getActiveRepo } from "./config.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "claudequeue",
    version: "1.0.0",
  });

  function getRepoPath(): string {
    const repo = getActiveRepo();
    if (!repo) throw new Error("No active repo configured in claudequeue");
    return repo.path;
  }

  function getActiveTask(repoPath: string) {
    const tasks = parseTasks(repoPath);
    return tasks.find((t) => t.status === "ACTIVE") ?? null;
  }

  server.tool(
    "mark_task_done",
    "Mark the currently active task as DONE",
    { summary: z.string().describe("Brief summary of what was accomplished") },
    async ({ summary }) => {
      const repoPath = getRepoPath();
      const task = getActiveTask(repoPath);
      if (!task) {
        return { content: [{ type: "text", text: "No active task found" }] };
      }
      updateTaskStatus(repoPath, task.id, "DONE", summary);
      return {
        content: [{ type: "text", text: `Task "${task.title}" marked as DONE: ${summary}` }],
      };
    }
  );

  server.tool(
    "log_decision",
    "Log a decision made during the current task",
    {
      decision: z.string().describe("The decision that was made"),
      reason: z.string().describe("Why this decision was made"),
    },
    async ({ decision, reason }) => {
      const repoPath = getRepoPath();
      appendDecision(repoPath, decision, reason);
      return {
        content: [{ type: "text", text: `Decision logged: ${decision} — ${reason}` }],
      };
    }
  );

  server.tool(
    "write_blocked",
    "Mark the current task as BLOCKED and stop",
    { reason: z.string().describe("Why the task cannot proceed") },
    async ({ reason }) => {
      const repoPath = getRepoPath();
      const task = getActiveTask(repoPath);
      if (!task) {
        return { content: [{ type: "text", text: "No active task found" }] };
      }
      updateTaskStatus(repoPath, task.id, "BLOCKED", reason);
      return {
        content: [
          { type: "text", text: `Task "${task.title}" marked as BLOCKED: ${reason}` },
        ],
      };
    }
  );

  server.tool(
    "get_current_task",
    "Get details about the currently active task",
    {},
    async () => {
      const repoPath = getRepoPath();
      const task = getActiveTask(repoPath);
      if (!task) {
        return { content: [{ type: "text", text: "No active task" }] };
      }
      const text = [
        `## [${task.status}] ${task.title}`,
        "",
        task.description,
        task.acceptanceCriteria ? `\nAcceptance: ${task.acceptanceCriteria}` : "",
      ]
        .join("\n")
        .trim();
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_project_context",
    "Get a summary of the entire queue status",
    {},
    async () => {
      const repoPath = getRepoPath();
      const tasks = parseTasks(repoPath);
      const done = tasks.filter((t) => t.status === "DONE").length;
      const pending = tasks.filter((t) => t.status === "PENDING").length;
      const active = tasks.filter((t) => t.status === "ACTIVE").length;
      const blocked = tasks.filter((t) => t.status === "BLOCKED").length;
      const text = [
        `Queue status: ${tasks.length} total tasks`,
        `  ✓ Done: ${done}`,
        `  → Active: ${active}`,
        `  · Pending: ${pending}`,
        `  ✗ Blocked: ${blocked}`,
        "",
        "Tasks:",
        ...tasks.map(
          (t) => `  [${t.status}] ${t.title}`
        ),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function setupClaudeSettings(): void {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settingsDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Warning: could not parse existing settings.json, creating fresh");
    }
  }

  // Find the claudequeue mcp binary path
  const mcpBinPath = path.resolve(process.argv[1], "../../dist/mcp-entry.js");

  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }
  (settings.mcpServers as Record<string, unknown>)["claudequeue"] = {
    command: "node",
    args: [mcpBinPath],
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`✓ MCP server entry written to ${settingsPath}`);
  console.log(`  Command: node ${mcpBinPath}`);

  // Install /queue slash command
  const commandsDir = path.join(os.homedir(), ".claude", "commands");
  if (!fs.existsSync(commandsDir)) {
    fs.mkdirSync(commandsDir, { recursive: true });
  }
  const commandPath = path.join(commandsDir, "queue.md");
  fs.writeFileSync(commandPath, QUEUE_COMMAND);
  console.log(`✓ /queue slash command installed at ${commandPath}`);
}

const QUEUE_COMMAND = `\
View and manage your claudequeue task queue — check status, mark tasks done, log decisions, and more.

## Step 1 — Ensure the UI server is running

Run this bash command to check:
\`\`\`bash
curl -s http://localhost:3141/api/scheduler/status 2>/dev/null
\`\`\`

If it fails or returns an error, start the server in the background and wait until it is ready:
\`\`\`bash
nohup claudequeue start > /tmp/claudequeue.log 2>&1 &
for i in $(seq 1 20); do
  curl -s http://localhost:3141/api/scheduler/status > /dev/null 2>&1 && break
  sleep 0.5
done
\`\`\`

## Step 2 — Open the dashboard in the browser

\`\`\`bash
explorer.exe http://localhost:3141 2>/dev/null || xdg-open http://localhost:3141 2>/dev/null || open http://localhost:3141 2>/dev/null || true
\`\`\`

## Step 3 — Show queue status

Call get_project_context and display the results in a clean, readable format grouped by status.

Then, if $ARGUMENTS is provided, act on it:

- "done [summary]" — call mark_task_done with the summary. Show updated status.
- "blocked [reason]" — call write_blocked with the reason. Show updated status.
- "decide [decision] because [reason]" — call log_decision with decision and reason.
- "current" — call get_current_task and show full details of the active task.

Always end with: "Dashboard open at http://localhost:3141"
`;

