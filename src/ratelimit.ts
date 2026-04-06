import { spawn } from "child_process";

// TODO: verify these patterns empirically against real Claude Code output
// Known patterns to check:
//   - "Claude.ai usage limit reached"
//   - "rate limit"
//   - "too many requests"
//   - "429"
//   - "quota exceeded"
//   - "Usage limit reached"
//   - "Rate limited"
const RATE_LIMIT_PATTERNS = [
  /claude\.ai usage limit reached/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota exceeded/i,
  /usage limit reached/i,
  /rate limited/i,
  /you've reached your.*limit/i,
  /api usage limit/i,
];

export function detectRateLimit(output: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(output));
}

function spawnClaudeVersion(): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "ignore" });
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
    // Timeout after 10 seconds
    setTimeout(() => {
      proc.kill();
      resolve(1);
    }, 10_000);
  });
}

export interface WaitForResetOptions {
  pollIntervalMs: number;
  onPollAttempt: (attemptNumber: number, nextAttemptIn: number) => void;
}

export async function waitForReset(opts: WaitForResetOptions): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt++;
    const exitCode = await spawnClaudeVersion();
    if (exitCode === 0) {
      console.log(`[${new Date().toISOString()}] Rate limit resolved after ${attempt} poll(s)`);
      return;
    }
    console.log(
      `[${new Date().toISOString()}] Rate limit still active (attempt ${attempt}), retrying in ${opts.pollIntervalMs / 1000}s`
    );
    opts.onPollAttempt(attempt, opts.pollIntervalMs);
    await sleep(opts.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
