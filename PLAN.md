# claudequeue — Build Plan

## What is this?

A CLI tool + MCP plugin that wraps Claude Code to enable scheduled, queue-based autonomous execution. Leave it running overnight — it works through your task queue, handles rate limits automatically, and presents everything through a browser dashboard.

**Two parts, one package:**
- **Scheduler daemon** — drives Claude Code from outside, handles rate limits, manages the queue
- **MCP server** — gives Claude Code native tools to report its own progress mid-run

---

## Core architecture

```
~/.claudequeue/
├── config.json          # registered repos + global settings
└── logs/
    └── {repo-name}/     # per-repo run logs

{project}/
└── queue.md             # lives in each repo root
```

One global daemon, one global UI, multiple repos registered. Daemon runs one repo at a time, UI manages everything.

---

## Tech stack

- **Runtime**: Node.js + TypeScript
- **CLI**: Commander.js
- **PTY spawning**: node-pty
- **MCP server**: @modelcontextprotocol/sdk
- **Backend**: Express + WebSocket (ws) for live log streaming
- **Frontend**: Single HTML file, vanilla JS, no framework
- **Validation**: Zod
- **Storage**: JSON files + markdown (no database)

---

## Project structure

```
claudequeue/
├── src/
│   ├── index.ts              # CLI entry
│   ├── scheduler.ts          # daemon loop
│   ├── runner.ts             # node-pty claude spawner
│   ├── ratelimit.ts          # detection + polling
│   ├── queue.ts              # queue.md parser/writer
│   ├── config.ts             # global config manager
│   ├── mcp.ts                # MCP server
│   └── ui/
│       ├── server.ts         # express + websocket server
│       └── index.html        # dashboard SPA
├── package.json
├── tsconfig.json
└── README.md
```

---

## queue.md format

```markdown
## [PENDING] Task 1 — Implement PubChem integration
Full description of what needs to be done.
Acceptance: specific measurable outcome.

## [ACTIVE] Task 2 — Build search component
...

## [DONE] Task 3 — Setup project ✓
Completed: 2024-01-15 02:34 — Created Vite scaffold with TypeScript

## [BLOCKED] Task 4 — Deploy to Vercel
Blocked: Missing API key, cannot proceed
```

---

## Build order

```
M1 scaffold → M2 config → M3 queue → M4 runner
→ M5 ratelimit → M6 scheduler → M7 mcp → M8 ui → M9 polish
```

---

## Session rules for Claude Code

Paste these at the start of **every session**:

> *"Read all existing src/ files before writing anything. This is milestone N of 9 — do not work ahead. When done, summarize exactly what was created or modified."*

---

## M1 — Project scaffold

**Goal**: repo exists, builds, CLI responds

- Init npm + TypeScript, install all deps
- `tsconfig.json` for Node ESM
- All CLI commands stubbed: `init`, `start`, `setup`, `add`
- `claudequeue --help` lists all commands
- `npm link` works in WSL

**Prompt:**
> *"Scaffold a Node.js TypeScript CLI tool called claudequeue. Use commander.js. Configure tsconfig for Node ESM. Install dependencies: commander, node-pty, @modelcontextprotocol/sdk, express, ws, zod. Stub four commands: start (starts daemon + UI), setup (configures Claude Code integration), add (registers a repo), init (creates queue.md in cwd). npm link it globally. claudequeue --help should list all commands with descriptions."*

---

## M2 — Global config manager

**Goal**: tool knows about multiple repos, persists state

Config shape:
```typescript
interface Config {
  repos: {
    id: string           // slugified name
    name: string         // display name
    path: string         // absolute path
    addedAt: string
  }[]
  activeRepoId: string | null
  ui: {
    port: number         // default 3141
  }
}
```

Deliverables:
- `config.ts` — reads/writes `~/.claudequeue/config.json`
- Exports: `getConfig()`, `addRepo(path)`, `setActiveRepo(id)`, `getActiveRepo()`
- `claudequeue add <path>` registers a repo, validates path exists, derives name from folder name
- Creates `~/.claudequeue/` directory structure on first run

**Prompt:**
> *"Implement src/config.ts for claudequeue. It manages a global config at ~/.claudequeue/config.json. Define the Config interface with repos array and activeRepoId. Export: getConfig(), saveConfig(), addRepo(repoPath: string), removeRepo(id: string), setActiveRepo(id: string), getActiveRepo(). Implement the add CLI command which calls addRepo() and prints confirmation. Create ~/.claudequeue/logs/ directory structure on init. Validate that the path exists before adding."*

---

## M3 — Queue parser

**Goal**: queue.md read/write works reliably

Deliverables:
- `queue.ts` — full parser and writer
- Exports: `parseTasks()`, `getNextPending()`, `updateTaskStatus()`, `appendDecision()`, `appendLog()`
- `claudequeue init` writes template queue.md to cwd with 3 example tasks
- Unit tests for parser edge cases

**Prompt:**
> *"Implement src/queue.ts for claudequeue. Parse queue.md files where tasks are h2 headings with [PENDING/ACTIVE/DONE/BLOCKED] status tags followed by optional description and acceptance criteria. Export: parseTasks(repoPath), getNextPending(repoPath), updateTaskStatus(repoPath, taskId, status, summary?), appendDecision(repoPath, decision, reason), appendLog(repoPath, message). Status changes should update the heading tag and append metadata (timestamp, summary) as a blockquote under the heading. Implement claudequeue init which writes a template queue.md. Include unit tests."*

---

## M4 — Claude runner

**Goal**: spawns claude CLI, streams output, resolves on exit

Autonomy prompt template:
```
You are running autonomously as part of claudequeue.
The user is unavailable — do not ask clarifying questions.
Make reasonable decisions independently and document them
using your MCP tools.

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
Acceptance criteria: {acceptanceCriteria}
```

Deliverables:
- `runner.ts` spawns claude with node-pty
- Streams output to `~/.claudequeue/logs/{repoId}/run.log`
- Emits output events for WebSocket streaming to UI
- Returns typed result: `done | blocked | ratelimited | error`

**Prompt:**
> *"Implement src/runner.ts for claudequeue. Use node-pty to spawn the claude CLI with a constructed prompt. Accept a RunnerOptions object with projectPath, task details, and an onOutput callback. Stream all PTY output to both ~/.claudequeue/logs/{repoId}/run.log and the onOutput callback. Prepend the autonomy instruction template (defined as a constant with interpolation). Return a promise resolving to a RunnerResult type: {outcome: 'done' | 'blocked' | 'ratelimited' | 'error', exitCode: number}. The outcome is initially 'done' on clean exit — ratelimit detection is handled by the caller."*

---

## M5 — Rate limit detection + polling

**Goal**: detects rate limit in output stream, waits, signals resume

- `ratelimit.ts` scans output strings for rate limit patterns
- TODO comment with known patterns to verify against real output
- Polls every 10 minutes via `claude --version`
- Emits polling events for UI countdown display
- Returns precise reset time estimate if detectable

**Prompt:**
> *"Implement src/ratelimit.ts for claudequeue. Export: detectRateLimit(output: string): boolean which scans for rate limit patterns in Claude Code stdout — add a TODO listing patterns to confirm empirically. Export: waitForReset(opts: {pollIntervalMs: number, onPollAttempt: (attemptNumber: number, nextAttemptIn: number) => void}): Promise<void> which polls by spawning claude --version every pollIntervalMs milliseconds, calling onPollAttempt before each wait, and resolving when the spawn succeeds. Log all state transitions with ISO timestamps."*

---

## M6 — Scheduler daemon

**Goal**: full orchestration loop working end to end

```
getNextPending()
      │
      ▼
mark ACTIVE → run claude
      │
      ├── done        → mark DONE → next task
      ├── blocked     → mark BLOCKED → next task
      ├── ratelimited → waitForReset → retry same task
      └── error       → log error → next task
      │
      ▼
queue empty → write session-summary.md → stop
```

Session summary format:
```markdown
# Session Summary — 2024-01-15

## Completed (3)
- Task 1: Implemented PubChem integration
- Task 2: Built search component
- Task 3: Wired simulation engine

## Decisions Made (2)
- Used React Query for caching (reason: simpler than manual state)
- Skipped error boundary (reason: not in acceptance criteria)

## Blocked (1)
- Task 4: Missing API key configuration

## Stats
- Started: 01:23
- Ended: 04:47
- Rate limit hits: 1
```

**Prompt:**
> *"Implement src/scheduler.ts for claudequeue. Export a Scheduler class with start(repoId) and stop() methods. The start loop: get next pending task via queue.ts, mark it active, pass to runner.ts with an onOutput callback that emits to an EventEmitter, check result — if ratelimited call ratelimit.ts waitForReset then retry the same task, if blocked/error move to next task, if done mark complete and continue. When queue empties write session-summary.md to the repo root. Expose events: task-started, task-done, task-blocked, output, ratelimit-detected, ratelimit-polling, queue-empty. Wire start command in index.ts to instantiate Scheduler with the active repo."*

---

## M7 — MCP server

**Goal**: Claude Code has native tools to report its own progress

Tools:
```
mark_task_done(summary: string)
  → marks active task DONE in queue.md

log_decision(decision: string, reason: string)
  → appends to queue.md under active task

write_blocked(reason: string)
  → marks active task BLOCKED, writes reason

get_current_task() → string
  → returns active task title + description

get_project_context() → string
  → returns queue status: X done, Y pending, Z blocked
```

- `claudequeue setup` auto-writes MCP entry to `~/.claude/settings.json`
- MCP server always runs as part of `claudequeue start`
- Uses same `queue.ts` functions as scheduler

**Prompt:**
> *"Implement src/mcp.ts for claudequeue using @modelcontextprotocol/sdk. Create an MCP server named claudequeue exposing 5 tools: mark_task_done (updates active task to DONE via queue.ts), log_decision (appends decision+reason under active task), write_blocked (marks active task BLOCKED), get_current_task (returns active task details as formatted string), get_project_context (returns full queue status summary). Use Zod for input schemas. Also implement the setup CLI command which reads ~/.claude/settings.json and injects the claudequeue MCP server entry pointing to the installed mcp.js binary, creating settings.json if absent."*

---

## M8 — Dashboard UI

**Goal**: full management interface in the browser

```
┌─────────────────────────────────────────────────────────┐
│  ⚡ claudequeue                              dark mode   │
├────────────────┬────────────────────────────────────────┤
│  REPOS         │  hplc-simulator                        │
│                │                                        │
│  ● hplc-sim    │  [PENDING] Task 1 — PubChem integration│
│    3 pending   │  Implement src/api/pubchem.ts...       │
│                │  ↕ drag to reorder                     │
│  ○ claudequeue │                                        │
│    1 active    │  [PENDING] Task 2 — Search component   │
│                │  Build the compound search UI...       │
│  + Add repo    │                                        │
│                │  [DONE] Task 3 — Project scaffold ✓   │
│                │  Completed 02:14 — Vite + TypeScript   │
│                │                                        │
│                │  + Add task                            │
├────────────────┴────────────────────────────────────────┤
│  ACTIVE: Task 2 — Search component    [■ Stop]          │
│  ████████████░░░░░░░░  2/4 tasks                       │
├─────────────────────────────────────────────────────────┤
│  LIVE LOG                                               │
│  02:34:12 ✓ Task 1 complete                            │
│  02:34:13 → Starting Task 2                            │
│  02:34:15   Creating src/components/Search.tsx...      │
└─────────────────────────────────────────────────────────┘
```

Features:
- Repo sidebar — click to switch, shows task count + status
- Add repo by typing path
- Task list — add, edit, delete, drag to reorder
- Start/Stop button
- Progress bar — tasks done / total
- Live log — WebSocket stream from scheduler events
- Rate limit countdown when waiting
- Single `index.html`, vanilla JS, no build step

**Prompt:**
> *"Implement src/ui/server.ts and src/ui/index.html for claudequeue. The Express server exposes REST endpoints: GET /api/repos, POST /api/repos (add by path), GET /api/repos/:id/tasks, POST /api/repos/:id/tasks, PATCH /api/repos/:id/tasks/:taskId, DELETE /api/repos/:id/tasks/:taskId, PATCH /api/repos/:id/tasks/reorder, POST /api/scheduler/start (repoId), POST /api/scheduler/stop. Add a WebSocket server on the same port — broadcast scheduler events (task-started, task-done, output, ratelimit-polling) as JSON. The index.html is a single-file dashboard with: repo sidebar, task list with drag-to-reorder and inline editing, start/stop controls, progress bar, live log panel fed by WebSocket. Use CSS variables for theming, dark by default. No external JS dependencies."*

---

## M9 — Polish + README

**Goal**: someone finds this on GitHub and is running in 5 minutes

- README: what it is, 30-second install, queue.md format, screenshot placeholder
- `claudequeue doctor` — checks claude CLI on PATH, MCP registered, config valid
- Human-readable error messages with suggested fixes
- Rate limit countdown in both UI and terminal
- npm publish config

**Prompt:**
> *"Add final polish to claudequeue: (1) implement claudequeue doctor which checks that claude CLI is on PATH, ~/.claudequeue/config.json exists, and the MCP entry is in ~/.claude/settings.json — print a clear ✓/✗ for each. (2) Audit all error paths and make messages human-readable with suggested fixes. (3) Write a comprehensive README.md covering: what it is, install + setup steps, queue.md format with example, UI screenshot placeholder, how MCP tools work, and contributing guide. (4) Add npm publish config to package.json with files array, engines field specifying Node 18+, and a prepublish build script."*

---

## Install experience (end state)

```bash
# first time only
npm install -g claudequeue
claudequeue setup        # writes MCP entry to ~/.claude/settings.json

# every time after
claudequeue start        # starts UI + MCP server
                         # prints: "Open http://localhost:3141"
```

Everything else — adding repos, writing tasks, starting the daemon, watching logs — happens in the browser at `http://localhost:3141`.