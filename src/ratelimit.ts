import { spawn } from "child_process";

// Patterns matched against real Claude Code output
const RATE_LIMIT_PATTERNS = [
  /5-hour limit reached/i,
  /usage limit reached/i,
  /rate limit reached/i,
  /claude\.ai usage limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /\b429\b/,
];

export function detectRateLimit(output: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(output));
}

/**
 * Try to extract the reset time from Claude's rate limit message.
 * Handles: "5-hour limit reached - resets 3:45 PM" or "resets at 15:45"
 */
export function parseResetTime(output: string): Date | null {
  const match = /resets(?:\s+at)?\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)/i.exec(output);
  if (!match) return null;

  const timeParts = /(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i.exec(match[1]);
  if (!timeParts) return null;

  let hours = parseInt(timeParts[1], 10);
  const minutes = parseInt(timeParts[2], 10);
  const ampm = timeParts[3]?.toUpperCase();

  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;

  const reset = new Date();
  reset.setHours(hours, minutes, 0, 0);
  // If that time has already passed today, it must be tomorrow
  if (reset <= new Date()) reset.setDate(reset.getDate() + 1);

  return reset;
}

export interface WaitForResetOptions {
  resetTime?: Date | null;
  onTick: (msRemaining: number, nextTickIn: number) => void;
}

export async function waitForReset(opts: WaitForResetOptions): Promise<void> {
  if (opts.resetTime) {
    // Wait until the known reset time, ticking every 60 seconds
    console.log(`[${new Date().toISOString()}] Rate limit — waiting until ${opts.resetTime.toLocaleTimeString()}`);
    while (true) {
      const msRemaining = opts.resetTime.getTime() - Date.now();
      if (msRemaining <= 0) break;
      const tickMs = Math.min(60_000, msRemaining);
      opts.onTick(msRemaining, tickMs);
      await sleep(tickMs);
    }
    // Small buffer after reset time
    await sleep(5_000);

    // Verify the reset actually worked before resuming
    const exitCode = await spawnClaudeVersion();
    if (exitCode === 0) {
      console.log(`[${new Date().toISOString()}] Rate limit confirmed clear — resuming`);
      return;
    }

    // Still limited — fall through to polling loop
    console.log(`[${new Date().toISOString()}] Reset time passed but still rate limited — switching to 10min polling`);
  }

  // Poll claude --version every 10 minutes until it succeeds
  let attempt = 0;
  while (true) {
    attempt++;
    const exitCode = await spawnClaudeVersion();
    if (exitCode === 0) {
      console.log(`[${new Date().toISOString()}] Rate limit resolved after ${attempt} poll(s)`);
      return;
    }
    const tickMs = 10 * 60 * 1000;
    opts.onTick(-1, tickMs);
    console.log(`[${new Date().toISOString()}] Still rate limited (attempt ${attempt}), retrying in 10min`);
    await sleep(tickMs);
  }
}

function spawnClaudeVersion(): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "ignore" });
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
    setTimeout(() => { proc.kill(); resolve(1); }, 10_000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
