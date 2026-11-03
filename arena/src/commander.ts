// A Commander (adapted from Outpost Zero's adapter/src/battle/commander.ts): one AI model
// playing one player of an Agentium match. Each turn it asks the game what its player can see,
// sends that to the model in a fresh chat with the order tools, and has the game carry out the
// tool calls; the results open the next turn. The game never waits for a slow model unless the
// match is turn-based. Out of budget, the player is frozen: units keep their last orders.
import { EventEmitter } from "node:events";
import { SYSTEM_PROMPT, TOOLS } from "./orders.ts";
import { newMemory, turnText, type SideMemory } from "./view.ts";

export interface GameLink {
  observe(player: number): Promise<Record<string, any> | null>;
  order(player: number, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  // Resolves when the player may take its next turn (enough game time passed, or the match is turn-based and the next cycle began).
  waitTurn(player: number, fromTime: number, stopped: () => boolean): Promise<void>;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments?: string };
}

export interface ChatResult {
  message: { content?: string | null; tool_calls?: ToolCall[] };
  tokens: number;
  usd?: number | null;
  finish?: string;
  usage?: Record<string, number> | null;
}

export interface ModelClient {
  chat(model: string, body: Record<string, unknown>): Promise<ChatResult>;
}

export interface TurnLog {
  turn: number;
  at: string;
  gameTime: number;
  seconds: number;
  tokens: number;
  tokensTotal: number;
  cached?: number;
  usd?: number | null;
  prompt: string;
  reply: { content: string | null; tool_calls: { name: string; arguments: string }[] };
  results: string[];
  finish?: string;
  error?: string;
}

export type CommanderStatus = "starting" | "thinking" | "ordering" | "waiting" | "out of budget" | "defeated" | "won" | "stopped" | "failed";

export interface CommanderStats {
  player: number;
  name: string;
  model: string;
  status: CommanderStatus;
  turns: number;
  tokens: number;
  budget: number;
  avgTurnS: number | null;
  orders: number;
  refused: number;
  errors: number;
  lastError: string | null;
  lastOrders: string[];
  usd: number | null;
  cap: number | null;
}

const MAX_ORDERS_PER_TURN = 8;
const MAX_FAILURES_IN_A_ROW = 6;
export const MAX_REPLY_TOKENS = 16_000;

export class Commander extends EventEmitter {
  readonly player: number;
  readonly name: string;
  readonly civ: string;
  readonly model: string;
  readonly budget: number;
  readonly minutes: number;
  status: CommanderStatus = "starting";
  turns = 0;
  tokens = 0;
  orders = 0;
  refused = 0;
  errors = 0;
  lastError: string | null = null;
  lastOrders: string[] = [];
  usd: number | null = null;
  cap: number | null = null;
  private turnSeconds: number[] = [];
  private stopped = false;
  private memory: SideMemory = newMemory();
  private link: GameLink;
  private client: ModelClient;

  constructor(opts: { player: number; name: string; civ: string; model: string; budget: number; cap?: number | null; minutes: number }, link: GameLink, client: ModelClient) {
    super();
    this.player = opts.player;
    this.name = opts.name;
    this.civ = opts.civ;
    this.model = opts.model;
    this.budget = opts.budget;
    this.cap = opts.cap ?? null;
    this.minutes = opts.minutes;
    this.link = link;
    this.client = client;
  }

  start(): Promise<void> {
    return this.loop().catch((e) => {
      this.status = "failed";
      this.lastError = String(e instanceof Error ? e.message : e);
    });
  }

  stop(): void {
    this.stopped = true;
    if (!["out of budget", "defeated", "won", "failed"].includes(this.status)) this.status = "stopped";
  }

  stats(): CommanderStats {
    const avg = this.turnSeconds.length ? this.turnSeconds.reduce((a, b) => a + b, 0) / this.turnSeconds.length : null;
    return {
      player: this.player,
      name: this.name,
      model: this.model,
      status: this.status,
      turns: this.turns,
      tokens: this.tokens,
      budget: this.budget,
      avgTurnS: avg === null ? null : Math.round(avg * 10) / 10,
      orders: this.orders,
      refused: this.refused,
      errors: this.errors,
      lastError: this.lastError,
      lastOrders: this.lastOrders,
      usd: this.usd === null ? null : Math.round(this.usd * 10_000) / 10_000,
      cap: this.cap,
    };
  }

  private async loop(): Promise<void> {
    let results: string[] = [];
    let failures = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (!this.stopped) {
      if (this.tokens >= this.budget || (this.cap !== null && (this.usd ?? 0) >= this.cap)) {
        this.status = "out of budget";
        if (this.tokens < this.budget) this.lastError = `cost cap of $${this.cap} reached`;
        return;
      }
      const view = await this.link.observe(this.player).catch(() => null);
      if (this.stopped) return;
      if (!view) {
        await sleep(2000);
        continue;
      }
      if (view.state === "defeated") {
        this.status = "defeated";
        return;
      }
      if (view.state === "won") {
        this.status = "won";
        return;
      }
      this.status = "thinking";
      const started = Date.now();
      const gameTime = Number(view.time_s ?? 0);
      const prompt = turnText(view, results, this.memory, this.turns === 0);
      let reply: ChatResult;
      try {
        reply = await this.client.chat(this.model, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT(this.name, this.civ, this.minutes) },
            { role: "user", content: prompt },
          ],
          tools: TOOLS,
          tool_choice: "auto",
          max_tokens: MAX_REPLY_TOKENS,
          user: `agentium-p${this.player}`,
        });
      } catch (e) {
        this.errors++;
        failures++;
        this.lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
        this.emit("log", { turn: this.turns + 1, at: new Date(started).toISOString(), gameTime, seconds: (Date.now() - started) / 1000, tokens: 0, tokensTotal: this.tokens, prompt, reply: { content: null, tool_calls: [] }, results: [], error: this.lastError } satisfies TurnLog);
        if (failures >= MAX_FAILURES_IN_A_ROW) {
          this.status = "failed";
          return;
        }
        await sleep(Math.min(30_000, 3000 * failures));
        continue;
      }
      failures = 0;
      if (this.stopped) return;
      this.turns++;
      this.tokens += reply.tokens;
      if (typeof reply.usd === "number") this.usd = (this.usd ?? 0) + reply.usd;
      this.turnSeconds.push((Date.now() - started) / 1000);
      this.status = "ordering";
      results = [];
      const calls = reply.message.tool_calls ?? [];
      for (const call of calls.slice(0, MAX_ORDERS_PER_TURN)) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          results.push(`${call.function.name}: refused: the arguments were not valid JSON`);
          this.refused++;
          continue;
        }
        const r = await runOrder(this.link, this.player, call.function.name, args);
        this.orders++;
        if (!r.ok) this.refused++;
        results.push(r.line);
        if (this.stopped) return;
      }
      if (calls.length > MAX_ORDERS_PER_TURN) results.push(`only the first ${MAX_ORDERS_PER_TURN} orders were carried out`);
      if (calls.length === 0 && reply.finish === "length") results.push(`no orders given: your reply ran out of room (${MAX_REPLY_TOKENS} tokens) before any orders; think less and give orders with the tools`);
      else if (calls.length === 0) results.push(`no orders given${reply.message.content ? ` (you wrote: ${String(reply.message.content).slice(0, 120)})` : ""}; use the tools`);
      this.lastOrders = results;
      this.emit("log", {
        turn: this.turns,
        at: new Date(started).toISOString(),
        gameTime,
        seconds: this.turnSeconds[this.turnSeconds.length - 1],
        tokens: reply.tokens,
        tokensTotal: this.tokens,
        cached: reply.usage?.x_cache_read ?? 0,
        usd: reply.usd ?? null,
        prompt,
        reply: { content: reply.message.content ?? null, tool_calls: calls.map((c) => ({ name: c.function.name, arguments: c.function.arguments ?? "" })) },
        results: [...results],
        ...(reply.finish ? { finish: reply.finish } : {}),
      } satisfies TurnLog);
      this.emit("turn", this.stats());
      this.status = "waiting";
      await this.link.waitTurn(this.player, gameTime, () => this.stopped);
    }
  }
}

// One order carried out by the game: "train(unit=infantry_spearman, count=5): done: training 5x
// infantry_spearman_b at barracks (4812)" or "...: refused: <the game's reason>".
export async function runOrder(link: GameLink, player: number, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; line: string; message: string }> {
  const r = await link.order(player, name, normalise(args)).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
  const message = String(r.message ?? "no answer");
  return { ok: !!r.ok, message, line: `${name}(${short(args)}): ${r.ok ? "done" : "refused"}: ${message}` };
}

// "units": "4812, 4813" becomes a list of ids; numbers stay numbers.
function normalise(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const k of ["units"]) {
    const v = out[k];
    if (typeof v === "string" && v.includes(",")) out[k] = v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  }
  return out;
}

function short(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
    .join(", ")
    .slice(0, 100);
}
