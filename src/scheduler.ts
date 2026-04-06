import EventEmitter from "events";
import fs from "fs";
import path from "path";
import { getConfig, type RepoConfig } from "./config.js";
import { parseTasks, getNextPending, updateTaskStatus } from "./queue.js";
import { spawnRunner, type RunnerHandle } from "./runner.js";
import { detectRateLimit, parseResetTime, waitForReset } from "./ratelimit.js";

interface SessionSummary {
  startedAt: string;
  endedAt: string;
  completed: { title: string; repoName: string; summary?: string }[];
  blocked: { title: string; repoName: string; reason?: string }[];
  decisions: string[];
  rateLimitHits: number;
}

function getNextPendingAcrossRepos(repos: RepoConfig[]): { task: ReturnType<typeof getNextPending>; repo: RepoConfig } | null {
  for (const repo of repos) {
    const task = getNextPending(repo.path);
    if (task) return { task, repo };
  }
  return null;
}

export class Scheduler extends EventEmitter {
  private running = false;
  private stopRequested = false;
  private currentHandle?: RunnerHandle;
  private session: SessionSummary = {
    startedAt: "",
    endedAt: "",
    completed: [],
    blocked: [],
    decisions: [],
    rateLimitHits: 0,
  };

  async start(): Promise<void> {
    if (this.running) throw new Error("Scheduler is already running");

    const config = getConfig();
    if (config.repos.length === 0) {
      throw new Error("No repos registered. Add a repo first.");
    }

    // Reset any tasks stuck in ACTIVE state from a previous interrupted run
    for (const repo of config.repos) {
      const tasks = parseTasks(repo.path);
      for (const task of tasks.filter((t) => t.status === "ACTIVE")) {
        updateTaskStatus(repo.path, task.id, "PENDING");
      }
    }

    this.running = true;
    this.stopRequested = false;
    this.session = {
      startedAt: new Date().toISOString(),
      endedAt: "",
      completed: [],
      blocked: [],
      decisions: [],
      rateLimitHits: 0,
    };

    try {
      await this.runLoop();
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.currentHandle?.kill();
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      const config = getConfig();
      const next = getNextPendingAcrossRepos(config.repos);

      if (!next) {
        this.session.endedAt = new Date().toISOString();
        const summary = { ...this.session };
        writeSessionSummary(summary);
        this.emit("queue-empty", summary);
        return;
      }

      const { task, repo } = next;
      if (!task) break;

      const allTasks = parseTasks(repo.path);

      this.emit("task-started", { id: task.id, title: task.title, index: task.index, repoId: repo.id, repoName: repo.name });
      updateTaskStatus(repo.path, task.id, "ACTIVE");

      let rateLimitDetected = false;
      let rateLimitResetTime: Date | undefined;
      const outputBuffer: string[] = [];

      this.currentHandle = spawnRunner({
        repoId: repo.id,
        projectPath: repo.path,
        taskNumber: task.index,
        totalTasks: allTasks.length,
        taskTitle: task.title,
        taskDescription: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        onOutput: (data) => {
          this.emit("output", { text: data, repoId: repo.id, taskId: task.id });
          outputBuffer.push(data);
          if (!rateLimitDetected && detectRateLimit(data)) {
            rateLimitDetected = true;
            // Try to extract exact reset time from the message
            const fullOutput = outputBuffer.join("");
            rateLimitResetTime = parseResetTime(fullOutput) ?? parseResetTime(data) ?? undefined;
          }
        },
      });

      const result = await this.currentHandle.result;
      this.currentHandle = undefined;

      if (rateLimitDetected) {
        this.session.rateLimitHits++;
        updateTaskStatus(repo.path, task.id, "PENDING");
        this.emit("ratelimit-detected", { resetTime: rateLimitResetTime?.toISOString() ?? null });

        await waitForReset({
          resetTime: rateLimitResetTime ?? null,
          onTick: (msRemaining, nextTickIn) => {
            this.emit("ratelimit-polling", { msRemaining, nextTickIn });
          },
        });
        continue;
      }

      if (result.outcome === "done") {
        updateTaskStatus(repo.path, task.id, "DONE");
        this.session.completed.push({ title: task.title, repoName: repo.name });
        this.emit("task-done", { id: task.id, title: task.title, repoId: repo.id, repoName: repo.name });
      } else if (result.outcome === "blocked") {
        updateTaskStatus(repo.path, task.id, "BLOCKED");
        this.session.blocked.push({ title: task.title, repoName: repo.name });
        this.emit("task-blocked", { id: task.id, title: task.title, repoId: repo.id, repoName: repo.name });
      } else {
        const reason = `Runner exited with code ${result.exitCode}`;
        updateTaskStatus(repo.path, task.id, "BLOCKED", reason);
        this.session.blocked.push({ title: task.title, repoName: repo.name, reason });
        this.emit("task-blocked", { id: task.id, title: task.title, repoId: repo.id, repoName: repo.name, reason });
        this.emit("error", new Error(`Task "${task.title}" in ${repo.name} failed: ${reason}`));
      }
    }
  }
}

function writeSessionSummary(session: SessionSummary): void {
  const config = getConfig();
  if (config.repos.length === 0) return;

  const date = new Date().toISOString().split("T")[0];
  const startTime = session.startedAt.split("T")[1]?.substring(0, 5) ?? "?";
  const endTime = session.endedAt.split("T")[1]?.substring(0, 5) ?? "?";

  const lines: string[] = [
    `# Session Summary — ${date}`,
    "",
    `## Completed (${session.completed.length})`,
  ];
  for (const t of session.completed) {
    lines.push(`- [${t.repoName}] ${t.title}${t.summary ? `: ${t.summary}` : ""}`);
  }
  if (session.completed.length === 0) lines.push("- (none)");

  lines.push("", `## Blocked (${session.blocked.length})`);
  for (const t of session.blocked) {
    lines.push(`- [${t.repoName}] ${t.title}${t.reason ? `: ${t.reason}` : ""}`);
  }
  if (session.blocked.length === 0) lines.push("- (none)");

  lines.push(
    "",
    "## Stats",
    `- Started: ${startTime}`,
    `- Ended: ${endTime}`,
    `- Rate limit hits: ${session.rateLimitHits}`,
    ""
  );

  // Write to the first repo's path as a sensible default
  const summaryPath = path.join(config.repos[0].path, "session-summary.md");
  fs.writeFileSync(summaryPath, lines.join("\n"));
}

export const scheduler = new Scheduler();
