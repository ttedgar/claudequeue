import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { getConfig, addRepo, removeRepo, setActiveRepo, getLogsDir } from "../config.js";
import { parseTasks, updateTaskStatus, updateTask, writeQueueTemplate, type Task, type TaskStatus } from "../queue.js";
import { scheduler } from "../scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startUIServer(port: number): http.Server {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
  });

  // --- Repos ---
  app.get("/api/repos", (_req, res) => {
    const config = getConfig();
    res.json({ repos: config.repos, activeRepoId: config.activeRepoId });
  });

  app.post("/api/repos", (req, res) => {
    const { repoPath } = req.body as { repoPath: string };
    if (!repoPath) { res.status(400).json({ error: "repoPath is required" }); return; }
    try {
      const repo = addRepo(repoPath);
      // Auto-create queue.md if missing
      const queuePath = path.join(repo.path, "queue.md");
      if (!fs.existsSync(queuePath)) {
        writeQueueTemplate(repo.path);
      }
      res.json({ repo });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/repos/:id", (req, res) => {
    try {
      removeRepo(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/repos/:id/activate", (req, res) => {
    try {
      setActiveRepo(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // --- Unified tasks across all repos ---
  app.get("/api/tasks", (_req, res) => {
    const config = getConfig();
    const all: (Task & { repoId: string; repoName: string })[] = [];
    for (const repo of config.repos) {
      const tasks = parseTasks(repo.path);
      for (const t of tasks) {
        all.push({ ...t, repoId: repo.id, repoName: repo.name });
      }
    }
    res.json({ tasks: all });
  });

  // --- Tasks per repo ---
  app.get("/api/repos/:id/tasks", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }
    res.json({ tasks: parseTasks(repo.path) });
  });

  app.post("/api/repos/:id/tasks", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }
    const { title, description, acceptanceCriteria } = req.body as { title: string; description?: string; acceptanceCriteria?: string };
    if (!title) { res.status(400).json({ error: "title is required" }); return; }

    const queuePath = path.join(repo.path, "queue.md");
    if (!fs.existsSync(queuePath)) writeQueueTemplate(repo.path);

    const newTask = [
      `\n## [PENDING] ${title}`,
      description ?? "",
      acceptanceCriteria ? `Acceptance: ${acceptanceCriteria}` : "",
    ].filter(Boolean).join("\n");
    fs.appendFileSync(queuePath, newTask + "\n");
    res.json({ tasks: parseTasks(repo.path) });
  });

  app.patch("/api/repos/:id/tasks/:taskId", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }

    const { status, summary, title, description, acceptanceCriteria } = req.body as {
      status?: TaskStatus;
      summary?: string;
      title?: string;
      description?: string;
      acceptanceCriteria?: string;
    };

    try {
      if (title !== undefined || description !== undefined || acceptanceCriteria !== undefined) {
        updateTask(repo.path, req.params.taskId, { title, description, acceptanceCriteria });
      }
      if (status) {
        updateTaskStatus(repo.path, req.params.taskId, status, summary);
      }
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json({ tasks: parseTasks(repo.path) });
  });

  app.delete("/api/repos/:id/tasks/:taskId", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }

    const queuePath = path.join(repo.path, "queue.md");
    if (!fs.existsSync(queuePath)) { res.status(404).json({ error: "queue.md not found" }); return; }

    const content = fs.readFileSync(queuePath, "utf-8");
    const lines = content.split("\n");
    const out: string[] = [];
    let skip = false;
    const headingRe = /^## \[(PENDING|ACTIVE|DONE|BLOCKED)\] (.+)$/;
    for (const line of lines) {
      const match = headingRe.exec(line);
      if (match) {
        const id = match[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        skip = id === req.params.taskId;
      }
      if (!skip) out.push(line);
    }
    fs.writeFileSync(queuePath, out.join("\n"));
    res.json({ tasks: parseTasks(repo.path) });
  });

  app.patch("/api/repos/:id/tasks/reorder", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }

    const { order } = req.body as { order: string[] };
    const tasks = parseTasks(repo.path);
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const reordered = order.map((id) => taskMap.get(id)).filter(Boolean) as Task[];
    const remaining = tasks.filter((t) => !order.includes(t.id));
    const all = [...reordered, ...remaining];

    const queuePath = path.join(repo.path, "queue.md");
    const headerMatch = fs.readFileSync(queuePath, "utf-8").match(/^(#[^\n]*\n)/);
    const header = headerMatch ? headerMatch[1] + "\n" : "";
    const newContent = header + all.map((t) => `## [${t.status}] ${t.title}\n${t.rawBody}`).join("\n\n") + "\n";
    fs.writeFileSync(queuePath, newContent);
    res.json({ tasks: parseTasks(repo.path) });
  });

  // --- Usage stats from ~/.claude/projects/**/*.jsonl ---
  app.get("/api/usage", (_req, res) => {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) { res.json({ hourly: [], daily: [], windowTokens: 0, windowPct: 0 }); return; }

    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    interface Bucket { tokens: number; messages: number; }
    const hourlyMap = new Map<number, Bucket>();
    const dailyMap  = new Map<string, Bucket>();

    // Pre-fill buckets so empty hours/days still show
    for (let i = 4; i >= 0; i--) {
      const h = Math.floor((now - i * 3600000) / 3600000) * 3600000;
      hourlyMap.set(h, { tokens: 0, messages: 0 });
    }
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().split("T")[0];
      dailyMap.set(d, { tokens: 0, messages: 0 });
    }

    // Walk all project JSONL files modified in the last 7 days
    const getAllJsonl = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir).flatMap((entry) => {
          const full = path.join(dir, entry);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) return getAllJsonl(full);
            if (entry.endsWith(".jsonl") && stat.mtimeMs >= sevenDaysAgo) return [full];
          } catch { /* skip */ }
          return [];
        });
      } catch { return []; }
    };

    for (const file of getAllJsonl(projectsDir)) {
      let content: string;
      try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            timestamp?: string;
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
          };
          if (!entry.timestamp || !entry.message?.usage) continue;

          const ts = new Date(entry.timestamp).getTime();
          if (isNaN(ts)) continue;

          const u = entry.message.usage;
          const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
                         (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

          if (ts >= fiveHoursAgo) {
            const hKey = Math.floor(ts / 3600000) * 3600000;
            if (hourlyMap.has(hKey)) {
              const b = hourlyMap.get(hKey)!;
              b.tokens += tokens; b.messages++;
            }
          }
          if (ts >= sevenDaysAgo) {
            const dKey = new Date(ts).toISOString().split("T")[0];
            if (dailyMap.has(dKey)) {
              const b = dailyMap.get(dKey)!;
              b.tokens += tokens; b.messages++;
            }
          }
        } catch { /* skip */ }
      }
    }

    const windowTokens = [...hourlyMap.values()].reduce((s, b) => s + b.tokens, 0);
    // Claude Code 5-hour standard limit is ~1M tokens (estimate — adjust if needed)
    const FIVE_HOUR_LIMIT = 1_000_000;
    const windowPct = Math.min(100, Math.round((windowTokens / FIVE_HOUR_LIMIT) * 100));

    const fmt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const fmtDay = (d: string) => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

    const hourly = [...hourlyMap.entries()].sort((a, b) => a[0] - b[0])
      .map(([ts, b]) => ({ label: fmt(ts), tokens: b.tokens, messages: b.messages }));

    const daily = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, b]) => ({ label: fmtDay(d), date: d, tokens: b.tokens, messages: b.messages }));

    res.json({ hourly, daily, windowTokens, windowPct, windowLimit: FIVE_HOUR_LIMIT });
  });

  // --- Task log ---
  app.get("/api/repos/:id/tasks/:taskId/log", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }

    const logsDir = getLogsDir(repo.id);
    const taskId = req.params.taskId;
    // Find the log file for this task (matches taskId slug in filename)
    let logContent = "";
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir).filter(f => f.includes(taskId) && f.endsWith(".log"));
      if (files.length > 0) {
        logContent = fs.readFileSync(path.join(logsDir, files[0]), "utf-8");
      }
    }
    res.json({ log: logContent });
  });

  // --- Import task from .md content ---
  app.post("/api/repos/:id/tasks/import", (req, res) => {
    const config = getConfig();
    const repo = config.repos.find((r) => r.id === req.params.id);
    if (!repo) { res.status(404).json({ error: "Repo not found" }); return; }

    const { content, filename } = req.body as { content: string; filename?: string };
    if (!content) { res.status(400).json({ error: "content is required" }); return; }

    // Extract title from first # heading, or use filename, or use first line
    let title = "";
    let body = content;
    const headingMatch = /^#\s+(.+)$/m.exec(content);
    if (headingMatch) {
      title = headingMatch[1].trim();
      body = content.slice(content.indexOf("\n") + 1).trim();
    } else if (filename) {
      title = filename.replace(/\.md$/i, "").replace(/[-_]/g, " ");
    } else {
      title = content.split("\n")[0].trim().substring(0, 80);
      body = content.split("\n").slice(1).join("\n").trim();
    }

    const queuePath = path.join(repo.path, "queue.md");
    if (!fs.existsSync(queuePath)) writeQueueTemplate(repo.path);

    const entry = `\n## [PENDING] ${title}\n${body}\n`;
    fs.appendFileSync(queuePath, entry);
    res.json({ tasks: parseTasks(repo.path) });
  });

  // --- Scheduler ---
  app.post("/api/scheduler/start", async (_req, res) => {
    if (scheduler.isRunning()) { res.status(409).json({ error: "Scheduler already running" }); return; }
    scheduler.start().catch(() => {});
    res.json({ ok: true });
  });

  app.post("/api/scheduler/stop", (_req, res) => {
    scheduler.stop();
    res.json({ ok: true });
  });

  app.get("/api/scheduler/status", (_req, res) => {
    res.json({ running: scheduler.isRunning() });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  function broadcast(event: string, data: unknown) {
    const msg = JSON.stringify({ event, data });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }

  scheduler.on("task-started", (task) => broadcast("task-started", task));
  scheduler.on("task-done", (task) => broadcast("task-done", task));
  scheduler.on("task-blocked", (task) => broadcast("task-blocked", task));
  scheduler.on("output", (data) => broadcast("output", data));
  scheduler.on("ratelimit-detected", (data) => broadcast("ratelimit-detected", data));
  scheduler.on("ratelimit-polling", (data) => broadcast("ratelimit-polling", data));
  scheduler.on("queue-empty", (summary) => broadcast("queue-empty", summary));
  scheduler.on("error", (err) => broadcast("error", { message: err.message }));

  server.listen(port, () => {
    console.log(`\n  claudequeue UI running at http://localhost:${port}\n`);
  });

  return server;
}
