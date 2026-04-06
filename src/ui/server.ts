import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getConfig, addRepo, removeRepo, setActiveRepo } from "../config.js";
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
  scheduler.on("output", (data) => broadcast("output", { text: data }));
  scheduler.on("ratelimit-detected", () => broadcast("ratelimit-detected", {}));
  scheduler.on("ratelimit-polling", (attempt, nextAttemptIn) => broadcast("ratelimit-polling", { attempt, nextAttemptIn }));
  scheduler.on("queue-empty", (summary) => broadcast("queue-empty", summary));
  scheduler.on("error", (err) => broadcast("error", { message: err.message }));

  server.listen(port, () => {
    console.log(`\n  claudequeue UI running at http://localhost:${port}\n`);
  });

  return server;
}
