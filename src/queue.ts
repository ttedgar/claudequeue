import fs from "fs";
import path from "path";

export type TaskStatus = "PENDING" | "ACTIVE" | "DONE" | "BLOCKED";

export interface Task {
  id: string;       // slugified title
  index: number;    // 1-based position in file
  title: string;
  status: TaskStatus;
  description: string;
  acceptanceCriteria: string;
  rawBody: string;  // everything after the heading
}

const QUEUE_FILE = "queue.md";

function getQueuePath(repoPath: string): string {
  return path.join(repoPath, QUEUE_FILE);
}

const STATUS_TAGS: TaskStatus[] = ["PENDING", "ACTIVE", "DONE", "BLOCKED"];
const HEADING_RE = /^## \[(PENDING|ACTIVE|DONE|BLOCKED)\] (.+)$/;

export function parseTasks(repoPath: string): Task[] {
  const queuePath = getQueuePath(repoPath);
  if (!fs.existsSync(queuePath)) return [];

  const content = fs.readFileSync(queuePath, "utf-8");
  const lines = content.split("\n");

  const tasks: Task[] = [];
  let currentIndex = 0;
  let i = 0;

  while (i < lines.length) {
    const match = HEADING_RE.exec(lines[i]);
    if (match) {
      currentIndex++;
      const status = match[1] as TaskStatus;
      const title = match[2].trim();
      const id = slugifyTitle(title);

      // Collect body lines until next h2 or EOF
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !HEADING_RE.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }

      const rawBody = bodyLines.join("\n").trim();
      const { description, acceptanceCriteria } = parseBody(rawBody);

      tasks.push({ id, index: currentIndex, title, status, description, acceptanceCriteria, rawBody });
    } else {
      i++;
    }
  }

  return tasks;
}

function parseBody(raw: string): { description: string; acceptanceCriteria: string } {
  const lines = raw.split("\n");
  const descLines: string[] = [];
  const acLines: string[] = [];
  let inAC = false;

  for (const line of lines) {
    if (/^acceptance[:\s]/i.test(line.trim())) {
      inAC = true;
      const rest = line.replace(/^acceptance[:\s]*/i, "").trim();
      if (rest) acLines.push(rest);
    } else if (inAC) {
      acLines.push(line);
    } else {
      descLines.push(line);
    }
  }

  return {
    description: descLines.join("\n").trim(),
    acceptanceCriteria: acLines.join("\n").trim(),
  };
}

function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function getNextPending(repoPath: string): Task | null {
  const tasks = parseTasks(repoPath);
  return tasks.find((t) => t.status === "PENDING") ?? null;
}

export function updateTask(
  repoPath: string,
  taskId: string,
  fields: { title?: string; description?: string; acceptanceCriteria?: string }
): void {
  const queuePath = getQueuePath(repoPath);
  if (!fs.existsSync(queuePath)) throw new Error(`queue.md not found at ${repoPath}`);

  const content = fs.readFileSync(queuePath, "utf-8");
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = HEADING_RE.exec(lines[i]);
    if (match && slugifyTitle(match[2].trim()) === taskId) {
      const newTitle = fields.title ?? match[2].trim();
      out.push(`## [${match[1]}] ${newTitle}`);
      i++;

      // Skip old body
      while (i < lines.length && !HEADING_RE.test(lines[i])) i++;

      // Write new body
      const task = parseTasks(repoPath).find((t) => t.id === taskId);
      const desc = fields.description ?? task?.description ?? "";
      const ac = fields.acceptanceCriteria ?? task?.acceptanceCriteria ?? "";
      if (desc) out.push(desc);
      if (ac) out.push(`Acceptance: ${ac}`);
      out.push("");
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  fs.writeFileSync(queuePath, out.join("\n"));
}

export function updateTaskStatus(
  repoPath: string,
  taskId: string,
  status: TaskStatus,
  summary?: string
): void {
  const queuePath = getQueuePath(repoPath);
  if (!fs.existsSync(queuePath)) throw new Error(`queue.md not found at ${repoPath}`);

  const content = fs.readFileSync(queuePath, "utf-8");
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = HEADING_RE.exec(lines[i]);
    if (match) {
      const title = match[2].trim();
      if (slugifyTitle(title) === taskId) {
        // Replace status tag
        out.push(`## [${status}] ${title}`);
        i++;

        // Collect existing body
        const bodyLines: string[] = [];
        while (i < lines.length && !HEADING_RE.test(lines[i])) {
          bodyLines.push(lines[i]);
          i++;
        }

        // Strip old metadata blockquotes at the end
        let bodyEnd = bodyLines.length;
        while (bodyEnd > 0 && /^>/.test(bodyLines[bodyEnd - 1].trim())) bodyEnd--;
        // Keep non-meta body
        const cleanBody = bodyLines.slice(0, bodyEnd);
        out.push(...cleanBody);

        // Append new metadata blockquote
        const ts = new Date().toISOString().replace("T", " ").substring(0, 16);
        if (status === "DONE") {
          out.push(`> Completed: ${ts}${summary ? ` — ${summary}` : ""}`);
        } else if (status === "BLOCKED") {
          out.push(`> Blocked: ${ts}${summary ? ` — ${summary}` : ""}`);
        } else if (status === "ACTIVE") {
          out.push(`> Started: ${ts}`);
        }
        out.push("");
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }

  fs.writeFileSync(queuePath, out.join("\n"));
}

export function appendDecision(repoPath: string, decision: string, reason: string): void {
  const queuePath = getQueuePath(repoPath);
  if (!fs.existsSync(queuePath)) throw new Error(`queue.md not found at ${repoPath}`);

  const tasks = parseTasks(repoPath);
  const activeTask = tasks.find((t) => t.status === "ACTIVE");
  if (!activeTask) {
    // Append to end of file
    const ts = new Date().toISOString().replace("T", " ").substring(0, 16);
    fs.appendFileSync(queuePath, `\n> Decision [${ts}]: ${decision} — ${reason}\n`);
    return;
  }

  // Insert decision under the active task's section
  const content = fs.readFileSync(queuePath, "utf-8");
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = HEADING_RE.exec(lines[i]);
    if (match && slugifyTitle(match[2].trim()) === activeTask.id) {
      out.push(lines[i]);
      i++;
      // collect body
      const bodyLines: string[] = [];
      while (i < lines.length && !HEADING_RE.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      out.push(...bodyLines);
      // Trim trailing blank lines to insert decision cleanly
      while (out.length && out[out.length - 1].trim() === "") out.pop();
      const ts = new Date().toISOString().replace("T", " ").substring(0, 16);
      out.push(`> Decision [${ts}]: ${decision} — ${reason}`);
      out.push("");
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  fs.writeFileSync(queuePath, out.join("\n"));
}

export function appendLog(repoPath: string, message: string): void {
  const queuePath = getQueuePath(repoPath);
  const ts = new Date().toISOString().replace("T", " ").substring(0, 16);
  fs.appendFileSync(queuePath, `\n> Log [${ts}]: ${message}\n`);
}

export function writeQueueTemplate(repoPath: string): void {
  const queuePath = getQueuePath(repoPath);
  const template = `# Task Queue

## [PENDING] Task 1 — Example: Set up project structure
Create the initial project scaffold with all required directories and configuration files.
Acceptance: Running \`npm install\` succeeds and the project builds without errors.

## [PENDING] Task 2 — Example: Implement core feature
Build the main functionality described in the project spec.
Acceptance: Feature works end-to-end with at least one passing test.

## [PENDING] Task 3 — Example: Write documentation
Document the public API and usage examples.
Acceptance: README covers install, configuration, and a getting-started example.
`;
  fs.writeFileSync(queuePath, template);
}
