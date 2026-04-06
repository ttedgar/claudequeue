import fs from "fs";
import path from "path";
import os from "os";

export interface RepoConfig {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface Config {
  repos: RepoConfig[];
  activeRepoId: string | null;
  ui: {
    port: number;
  };
}

const CLAUDEQUEUE_DIR = path.join(os.homedir(), ".claudequeue");
const CONFIG_PATH = path.join(CLAUDEQUEUE_DIR, "config.json");
const LOGS_DIR = path.join(CLAUDEQUEUE_DIR, "logs");

function ensureDir(): void {
  if (!fs.existsSync(CLAUDEQUEUE_DIR)) {
    fs.mkdirSync(CLAUDEQUEUE_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function getConfig(): Config {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig: Config = {
      repos: [],
      activeRepoId: null,
      ui: { port: 3141 },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Config;
}

export function saveConfig(config: Config): void {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  // Convert Windows path (C:\foo\bar or C:/foo/bar) to WSL path (/mnt/c/foo/bar)
  const winAbsolute = /^([A-Za-z]):[/\\](.*)$/;
  const match = winAbsolute.exec(trimmed);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return trimmed;
}

export function addRepo(repoPath: string): RepoConfig {
  const resolved = path.resolve(normalizeRepoPath(repoPath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  const config = getConfig();
  const existing = config.repos.find((r) => r.path === resolved);
  if (existing) {
    throw new Error(`Repo already registered: ${resolved} (id: ${existing.id})`);
  }

  const name = path.basename(resolved);
  const baseId = slugify(name);
  let id = baseId;
  let suffix = 2;
  while (config.repos.find((r) => r.id === id)) {
    id = `${baseId}-${suffix++}`;
  }

  const repo: RepoConfig = {
    id,
    name,
    path: resolved,
    addedAt: new Date().toISOString(),
  };

  config.repos.push(repo);
  if (!config.activeRepoId) {
    config.activeRepoId = id;
  }
  saveConfig(config);

  // Create log dir for this repo
  const repoLogDir = path.join(LOGS_DIR, id);
  if (!fs.existsSync(repoLogDir)) {
    fs.mkdirSync(repoLogDir, { recursive: true });
  }

  return repo;
}

export function removeRepo(id: string): void {
  const config = getConfig();
  const idx = config.repos.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new Error(`Repo not found: ${id}`);
  }
  config.repos.splice(idx, 1);
  if (config.activeRepoId === id) {
    config.activeRepoId = config.repos[0]?.id ?? null;
  }
  saveConfig(config);
}

export function setActiveRepo(id: string): void {
  const config = getConfig();
  if (!config.repos.find((r) => r.id === id)) {
    throw new Error(`Repo not found: ${id}`);
  }
  config.activeRepoId = id;
  saveConfig(config);
}

export function getActiveRepo(): RepoConfig | null {
  const config = getConfig();
  if (!config.activeRepoId) return null;
  return config.repos.find((r) => r.id === config.activeRepoId) ?? null;
}

export function getLogsDir(repoId: string): string {
  return path.join(LOGS_DIR, repoId);
}
