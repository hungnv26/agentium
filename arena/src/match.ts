// The match director: launches the game with the RL interface, starts it from a card, drives
// the clock (the engine only advances inside /step), runs one Commander per model player, sees
// the end (conquest or the time limit), stops the game so its replay is flushed, scores it and
// updates the Elo table.
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playerId, type MatchConfig } from "./card.ts";
import { Commander, type ChatResult, type CommanderStats, type GameLink, type ModelClient } from "./commander.ts";
import { updateElo } from "./elo.ts";
import { gameAttributes } from "./game/attributes.ts";
import { GameProcess, REPO_ROOT } from "./game/process.ts";
import type { Command } from "./game/rl.ts";
import { MatchLogs } from "./logs.ts";

export const DATA_DIR = process.env.ARENA_DATA ?? join(REPO_ROOT, "arena", ".data");
export const LOG_ROOT = process.env.ARENA_LOGS ?? join(REPO_ROOT, "arena", "match-logs");
export const ELO_PATH = join(DATA_DIR, "elo.json");

export type MatchState = "starting" | "running" | "finishing" | "finished" | "failed";

export interface PlayerResult {
  player: number;
  id: string;
  civ: string;
  controller: string;
  state: string; // active, won, defeated
  score: number;
  stats?: CommanderStats;
  statistics?: Record<string, unknown>;
}

export interface MatchResult {
  id: string;
  map: string;
  reason: "conquest" | "time limit" | "stopped" | "failed";
  winner: number | null; // player number
  winners: string[]; // player ids
  losers: string[];
  players: PlayerResult[];
  gameSeconds: number;
  turns: number;
  wallSeconds: number;
  replay: string | null; // the replay directory
  commandsTxt: string | null;
  error?: string;
}

// Match ids are local time: 2026-11-04_07-38-12.
const localId = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const sumNumbers = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).reduce((s: number, x) => s + sumNumbers(x), 0) : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Not 6000: the Fetch standard blocks ports 6000-6063 (X11), so Node's fetch would refuse them.
let nextPort = Number(process.env.RL_BASE_PORT ?? 7700);

export function makeModelClient(arenaCall: (spec: string, body: Record<string, unknown>, cacheKey?: string) => Promise<any>): ModelClient {
  return {
    async chat(model, body): Promise<ChatResult> {
      const r = await arenaCall(model, { ...body, model }, String(body.user ?? ""));
      if (r.status !== 200 || !r.reply) throw new Error(JSON.parse(r.text || "{}").error?.message ?? `gateway ${r.status}`);
      const choice = r.reply.choices?.[0] ?? {};
      return { message: choice.message ?? {}, tokens: r.tokens, usd: r.usd, finish: choice.finish_reason, usage: r.usage };
    },
  };
}

export class MatchDirector extends EventEmitter {
  readonly id: string;
  readonly config: MatchConfig;
  readonly game: GameProcess;
  readonly commanders = new Map<number, Commander>();
  state: MatchState = "starting";
  result: MatchResult | null = null;
  gameTime = 0; // seconds of game time, from the last status check
  turn = 0;
  status: { time_s: number; players: any[] } | null = null;
  private queue: { player: number; cmd: Command }[] = [];
  private logs: MatchLogs;
  private stopRequested = false;
  private stopReason: MatchResult["reason"] | null = null;
  private started = Date.now();
  private modelClient: ModelClient;
  private cycleWaiters: { resolve: () => void }[] = [];
  private cycle = 0;
  private turnsThisCycle = new Set<number>();
  private gameLines: string[] = [];

  constructor(config: MatchConfig, modelClient: ModelClient, id = localId()) {
    super();
    this.id = id;
    this.config = config;
    this.modelClient = modelClient;
    this.game = new GameProcess({ port: nextPort++, headless: config.headless, onLine: (l) => this.onGameLine(l) });
    this.logs = new MatchLogs(LOG_ROOT, id, config);
  }

  private onGameLine(line: string): void {
    this.gameLines.push(line);
    if (this.gameLines.length > 200) this.gameLines.shift();
    if (/ERROR|error:/i.test(line) && !/shader/i.test(line)) this.emit("log", `[game] ${line}`);
  }

  // What the setup page shows.
  snapshot(): Record<string, unknown> {
    return {
      id: this.id,
      state: this.state,
      map: this.config.map,
      gameTime: this.gameTime,
      turn: this.turn,
      wallSeconds: Math.round((Date.now() - this.started) / 1000),
      players: this.config.players.map((p, i) => ({
        player: i + 1,
        id: playerId(p),
        civ: p.civ,
        controller: p.controller,
        state: this.status?.players?.[i]?.state ?? "active",
        pop: this.status?.players?.[i]?.pop ?? null,
        phase: this.status?.players?.[i]?.phase ?? null,
        commander: this.commanders.get(i + 1)?.stats() ?? null,
      })),
      result: this.result,
      port: this.game.port,
    };
  }

  stop(reason: MatchResult["reason"] = "stopped"): void {
    this.stopRequested = true;
    this.stopReason ??= reason;
  }

  async run(): Promise<MatchResult> {
    try {
      await this.game.start();
      this.emit("log", `[match ${this.id}] game up on port ${this.game.port}, starting ${this.config.map}`);
      await this.game.client.reset(gameAttributes(this.config, this.config.headless), { saveReplay: true, playerID: this.config.headless ? 1 : -1 });
      this.state = "running";
      this.started = Date.now();
      this.startCommanders();
      await this.tick();
    } catch (e) {
      this.state = "failed";
      this.stopReason = "failed";
      this.emit("log", `[match ${this.id}] failed: ${e instanceof Error ? e.message : e}`);
      return this.finish(String(e instanceof Error ? e.message : e));
    }
    return this.finish();
  }

  private link(): GameLink {
    const client = this.game.client;
    return {
      observe: async (player) => {
        const view = await client.view(player);
        const s = this.status?.players?.[player - 1]?.state;
        if (s) view.state = s;
        return view;
      },
      order: async (player, name, args) => {
        const r = await client.resolve(player, { ...args, order: name });
        if (r.ok && r.commands?.length) for (const cmd of r.commands) this.queue.push({ player, cmd });
        return { ok: r.ok, message: r.message };
      },
      waitTurn: async (player, fromTime, stopped) => {
        if (this.config.pacing === "turnbased") {
          this.turnsThisCycle.add(player);
          const cycle = this.cycle;
          while (!stopped() && this.state === "running" && this.cycle === cycle) await new Promise<void>((resolve) => this.cycleWaiters.push({ resolve }));
          return;
        }
        const wait = this.config.turnSeconds ?? 7;
        while (!stopped() && this.state === "running" && this.gameTime - fromTime < wait) await sleep(300);
      },
    };
  }

  private startCommanders(): void {
    const link = this.link();
    this.config.players.forEach((p, i) => {
      if (p.controller !== "model") return;
      const player = i + 1;
      const c = new Commander({ player, name: p.name ?? p.model!, civ: p.civ, model: p.model!, budget: p.budget!, cap: p.cap, minutes: this.config.minutes }, link, this.modelClient);
      c.on("log", (t) => this.logs.turn(player, t));
      c.on("turn", (s: CommanderStats) => {
        this.turnsThisCycle.add(player);
        this.emit("turn", s);
        this.emit("log", `[p${player} ${p.model}] turn ${s.turns}: ${s.lastOrders.join(" | ").slice(0, 300)}`);
      });
      this.commanders.set(player, c);
      c.start();
    });
  }

  private modelPlayersAlive(): number[] {
    return [...this.commanders.entries()].filter(([, c]) => ["starting", "thinking", "ordering", "waiting"].includes(c.status)).map(([p]) => p);
  }

  // The clock. Realtime: `speed` turns per 200 ms of wall time (0 = as fast as possible).
  // Turn-based: `turnSeconds` of game time per cycle, then every live model player gets its turn.
  private async tick(): Promise<void> {
    const client = this.game.client;
    const turnsPerTick = this.config.speed === 0 ? 10 : Math.max(1, Math.round(this.config.speed));
    const intervalMs = this.config.speed === 0 ? 0 : 200;
    const limitTurns = this.config.minutes * 60 * 5;
    const cycleTurns = (this.config.turnSeconds ?? 7) * 5;
    let sinceStatus = 0;
    let cycleStartTurn = 0;
    while (!this.stopRequested) {
      const t0 = Date.now();
      const cmds = this.queue.splice(0, this.queue.length);
      const step = await client.step(cmds, turnsPerTick);
      this.turn = step.turn;
      sinceStatus += turnsPerTick;
      if (sinceStatus >= 25 || this.turn >= limitTurns) {
        sinceStatus = 0;
        this.status = await client.status();
        this.gameTime = this.status.time_s;
        this.emit("status", this.snapshot());
        const active = this.status.players.filter((p) => p.state === "active");
        const teams = new Set(active.map((p) => (p.team === -1 || p.team === undefined ? `p${p.id}` : `t${p.team}`)));
        if (teams.size <= 1) {
          this.stopReason = "conquest";
          break;
        }
        if (this.turn >= limitTurns) {
          this.stopReason = "time limit";
          break;
        }
      }
      if (this.config.pacing === "turnbased" && this.turn - cycleStartTurn >= cycleTurns) {
        // Let every live model player take a turn before the next cycle.
        cycleStartTurn = this.turn;
        const need = this.modelPlayersAlive();
        const deadline = Date.now() + 180_000;
        while (!this.stopRequested && need.some((p) => !this.turnsThisCycle.has(p)) && Date.now() < deadline) await sleep(200);
        this.turnsThisCycle.clear();
        this.cycle++;
        for (const w of this.cycleWaiters.splice(0)) w.resolve();
      }
      const left = intervalMs - (Date.now() - t0);
      if (left > 0) await sleep(left);
    }
    this.stopReason ??= "stopped";
  }

  private async finish(error?: string): Promise<MatchResult> {
    this.state = "finishing";
    for (const c of this.commanders.values()) c.stop();
    for (const w of this.cycleWaiters.splice(0)) w.resolve();
    let status = this.status;
    let replay: string | null = null;
    try {
      if (this.game.running) {
        status = await this.game.client.status().catch(() => status);
        const stopped = await this.game.client.stop();
        replay = stopped.replay ?? null;
      }
    } catch {}
    await this.game.kill();
    const reason = this.stopReason ?? (error ? "failed" : "stopped");
    const players: PlayerResult[] = this.config.players.map((p, i) => {
      const s = status?.players?.[i] ?? {};
      // Economy plus military: resources gathered, and the value of what was killed or destroyed.
      const score = Math.round(sumNumbers(s.resources_gathered) + sumNumbers(s.enemy_units_killed_value) + sumNumbers(s.enemy_buildings_destroyed_value));
      return { player: i + 1, id: playerId(p), civ: p.civ, controller: p.controller, state: s.state ?? "active", score, stats: this.commanders.get(i + 1)?.stats(), statistics: s };
    });
    let winner: number | null = null;
    const alive = players.filter((p) => p.state !== "defeated");
    if (reason === "conquest" && alive.length) winner = alive.reduce((a, b) => (b.score > a.score ? b : a)).player;
    else if (reason === "time limit" && alive.length) {
      const best = [...alive].sort((a, b) => b.score - a.score);
      if (best.length === 1 || best[0].score > best[1].score) winner = best[0].player;
    }
    const winners = winner ? [players[winner - 1].id] : [];
    const losers = players.filter((p) => p.player !== winner && p.controller !== "none").map((p) => p.id);
    const result: MatchResult = {
      id: this.id,
      map: this.config.map,
      reason,
      winner,
      winners,
      losers,
      players,
      gameSeconds: status?.time_s ?? this.gameTime,
      turns: this.turn,
      wallSeconds: Math.round((Date.now() - this.started) / 1000),
      replay,
      commandsTxt: replay ? join(replay, "commands.txt") : null,
      ...(error ? { error } : {}),
    };
    if (winner && reason !== "failed") updateElo(ELO_PATH, winners[0], losers);
    mkdirSync(join(DATA_DIR, "matches"), { recursive: true });
    writeFileSync(join(DATA_DIR, "matches", `${this.id}.json`), JSON.stringify(result, null, 2));
    this.logs.finish(result as unknown as Record<string, unknown>);
    this.result = result;
    this.state = error ? "failed" : "finished";
    this.emit("status", this.snapshot());
    this.emit("log", `[match ${this.id}] ${reason}: winner ${winner ? `player ${winner} (${winners[0]})` : "none"} after ${result.gameSeconds} game s, ${result.turns} turns, ${result.wallSeconds} s wall`);
    return result;
  }
}
