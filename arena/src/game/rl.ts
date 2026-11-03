// A client for the engine's RL interface (source/rlinterface/RLInterface.cpp): the game only
// advances inside /step, so whoever calls step owns the clock.
//   POST /reset?saveReplay&playerID=N   game attributes JSON        -> full state (large)
//   POST /step?state=none&turns=N       lines "pid;{command json}"  -> {ok, turn, player}
//   POST /evaluate                      JS in the simulation global -> JSON of the result
//   POST /stop                                                      -> {ok, turn, replay}
//   POST /templates                     template names, one per line

export interface StepResult {
  ok: boolean;
  turn: number;
  player?: number;
}

export interface StopResult {
  ok: boolean;
  turn?: number;
  replay?: string; // the replay directory on disk
}

export type Command = { type: string; [k: string]: unknown };

export class RlClient {
  readonly url: string;
  constructor(url: string) {
    this.url = url.replace(/\/$/, "");
  }

  private async post(path: string, body: string, timeoutMs = 120_000): Promise<string> {
    const r = await fetch(this.url + path, { method: "POST", headers: { "content-type": "text/plain" }, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} -> ${r.status}: ${text.slice(0, 200)}`);
    return text;
  }

  // True once the engine answers on the port (any response, including "game not running").
  async ping(): Promise<boolean> {
    try {
      await fetch(this.url + "/step", { method: "POST", body: "", signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  async waitUntilUp(timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.ping()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the game did not answer on ${this.url} within ${timeoutMs / 1000} s`);
  }

  // Starts a game; the (large) state it returns is discarded.
  async reset(attributes: unknown, opts: { saveReplay?: boolean; playerID?: number } = {}): Promise<void> {
    const q = new URLSearchParams();
    if (opts.saveReplay ?? true) q.set("saveReplay", "1");
    q.set("playerID", String(opts.playerID ?? 1));
    await this.post(`/reset?${q}`, JSON.stringify(attributes), 300_000);
  }

  // Posts commands for any players and advances `turns` turns of 200 ms.
  async step(commands: { player: number; cmd: Command }[] = [], turns = 1): Promise<StepResult> {
    const body = commands.map((c) => `${c.player};${JSON.stringify(c.cmd)}`).join("\n");
    const text = await this.post(`/step?state=none&turns=${turns}`, body);
    return JSON.parse(text) as StepResult;
  }

  // Runs JS in the simulation (strict mode: the code is wrapped in a function) and returns its value.
  async evaluate<T = unknown>(code: string): Promise<T> {
    const text = await this.post("/evaluate", `(function(){ ${code} })()`);
    return JSON.parse(text) as T;
  }

  async stop(): Promise<StopResult> {
    try {
      return JSON.parse(await this.post("/stop", "")) as StopResult;
    } catch (e) {
      return { ok: false };
    }
  }

  // ---- Agentium helpers (simulation/helpers/Agentium*.js) ----

  view(player: number): Promise<Record<string, any>> {
    return this.evaluate(`return AgentiumView(${player});`);
  }

  status(): Promise<{ time_s: number; players: { id: number; name: string; civ: string; team: number; state: string; pop: number; [k: string]: unknown }[] }> {
    return this.evaluate(`return AgentiumStatus();`);
  }

  resolve(player: number, order: Record<string, unknown>): Promise<{ ok: boolean; message: string; commands?: Command[] }> {
    return this.evaluate(`return AgentiumResolve(${player}, ${JSON.stringify(JSON.stringify(order))});`);
  }
}
