// Launches the game (binaries/system/pyrogenesis) with the RL interface, headless or in a window.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RlClient } from "./rl.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PYROGENESIS = process.env.PYROGENESIS ?? join(REPO_ROOT, "binaries", "system", "pyrogenesis");

export interface GameProcessOptions {
  port: number;
  headless: boolean;
  extraArgs?: string[];
  onLine?: (line: string) => void;
}

export class GameProcess {
  readonly port: number;
  readonly headless: boolean;
  readonly client: RlClient;
  private child: ChildProcess | null = null;
  private killing = false;
  private exited: Promise<number | null> | null = null;

  constructor(opts: GameProcessOptions) {
    this.port = opts.port;
    this.headless = opts.headless;
    this.client = new RlClient(`http://127.0.0.1:${opts.port}`);
    this.opts = opts;
  }
  private opts: GameProcessOptions;

  async start(): Promise<void> {
    if (!existsSync(PYROGENESIS)) throw new Error(`game binary not found at ${PYROGENESIS}; build it first (make -C build/workspaces/gcc config=release pyrogenesis)`);
    const args = [`-rl-interface=127.0.0.1:${this.port}`, "-unique-logs", ...(this.headless ? ["-autostart-nonvisual"] : ["-windowed"]), ...(this.opts.extraArgs ?? [])];
    this.child = spawn(PYROGENESIS, args, { cwd: dirname(PYROGENESIS), stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n"))
        if (line.trim()) {
          if (process.env.ARENA_DEBUG) console.log(`[game:${this.port}] ${line}`);
          this.opts.onLine?.(line);
        }
    };
    this.child.on("exit", (code, signal) => {
      if (!this.killing) this.opts.onLine?.(`ERROR: the game exited early (code ${code}, signal ${signal})`);
    });
    this.child.stdout?.on("data", onData);
    this.child.stderr?.on("data", onData);
    this.exited = new Promise((resolve) => this.child!.on("exit", (code) => resolve(code)));
    const earlyExit = this.exited.then((code) => {
      throw new Error(`the game exited with code ${code} before answering`);
    });
    earlyExit.catch(() => {}); // only matters while we wait below
    await Promise.race([this.client.waitUntilUp(this.headless ? 60_000 : 120_000), earlyExit]);
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  async kill(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    this.killing = true;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), 5000);
    await this.exited;
    clearTimeout(timer);
  }
}

// Plays a replay in a window (for the "watch" button).
export function watchReplay(commandsTxt: string): ChildProcess {
  return spawn(PYROGENESIS, [`-replay-visual=${commandsTxt}`, "-windowed"], { cwd: dirname(PYROGENESIS), stdio: "ignore", detached: true });
}
