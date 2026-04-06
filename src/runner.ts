import pty from "node-pty";
import fs from "fs";
import path from "path";
import { getLogsDir } from "./config.js";

export interface RunnerOptions {
  repoId: string;
  projectPath: string;
  taskNumber: number;
  totalTasks: number;
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string;
  onOutput: (data: string) => void;
}

export type RunnerOutcome = "done" | "blocked" | "ratelimited" | "error";

export interface RunnerResult {
  outcome: RunnerOutcome;
  exitCode: number;
}

export interface RunnerHandle {
  result: Promise<RunnerResult>;
  kill: () => void;
}

const AUTONOMY_TEMPLATE = `You are running autonomously as part of claudequeue.
The user is unavailable — do not ask clarifying questions.
Make reasonable decisions independently and document them using your MCP tools.

If you make a decision not covered by the plan:
  → call log_decision(decision, reason)

When the task is complete:
  → call mark_task_done(summary)

If you are genuinely blocked and cannot proceed:
  → call write_blocked(reason)
  → then stop

Project path: {projectPath}
Task {taskNumber} of {totalTasks}: {taskTitle}

─────────────────────────────────────
{taskDescription}
─────────────────────────────────────
Acceptance criteria: {acceptanceCriteria}`;

// Strip ANSI escape codes for clean UI display
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function buildPrompt(opts: RunnerOptions): string {
  return AUTONOMY_TEMPLATE
    .replace("{projectPath}", opts.projectPath)
    .replace("{taskNumber}", String(opts.taskNumber))
    .replace("{totalTasks}", String(opts.totalTasks))
    .replace("{taskTitle}", opts.taskTitle)
    .replace("{taskDescription}", opts.taskDescription)
    .replace("{acceptanceCriteria}", opts.acceptanceCriteria || "Complete the task as described.");
}

export function spawnRunner(opts: RunnerOptions): RunnerHandle {
  let killed = false;

  const result = new Promise<RunnerResult>((resolve) => {
    const prompt = buildPrompt(opts);
    const logsDir = getLogsDir(opts.repoId);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logPath = path.join(logsDir, "run.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const timestamp = new Date().toISOString();
    logStream.write(`\n\n--- Run started ${timestamp} ---\n`);
    logStream.write(`Task: ${opts.taskTitle}\n`);
    logStream.write("─".repeat(60) + "\n");

    const ptyProcess = pty.spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      name: "xterm-color",
      cols: 120,
      rows: 40,
      cwd: opts.projectPath,
      env: { ...process.env },
    });

    handle.kill = () => {
      if (!killed) {
        killed = true;
        ptyProcess.kill();
      }
    };

    ptyProcess.onData((data) => {
      logStream.write(data);
      opts.onOutput(stripAnsi(data));
    });

    ptyProcess.onExit(({ exitCode }) => {
      logStream.write(`\n--- Run ended ${new Date().toISOString()} (exit ${exitCode}) ---\n`);
      logStream.end();
      resolve({
        outcome: killed ? "error" : exitCode === 0 ? "done" : "error",
        exitCode: exitCode ?? 1,
      });
    });
  });

  const handle: RunnerHandle = {
    result,
    kill: () => { killed = true; }, // overwritten above once pty is spawned
  };

  return handle;
}
