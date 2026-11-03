// The Arena service: the setup page and its API on 127.0.0.1:8896, and the key gateway on 8895.
//   node src/server.ts    then open http://127.0.0.1:8896
// API (JSON): POST /arena/start {card}, POST /arena/stop, GET /arena/status, GET /arena/matches,
// GET /arena/elo, GET /arena/keys, PUT /arena/keys/<provider> (body: the key), GET /arena/models?provider=,
// GET /arena/maps, GET /replays/<id>/commands.txt, POST /arena/replay/<id>/watch (opens a game window).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { arenaCall, fetchModels, keyStatus, models, PROVIDERS, saveProviderKey, startGateway } from "../gateway.mjs";
import { parseCard } from "./card.ts";
import { REPO_ROOT, watchReplay } from "./game/process.ts";
import { readElo } from "./elo.ts";
import { DATA_DIR, ELO_PATH, makeModelClient, MatchDirector, type MatchResult } from "./match.ts";

const PORT = Number(process.env.ARENA_PORT ?? 8896);
const PUBLIC = join(REPO_ROOT, "arena", "public");
const MATCHES = join(DATA_DIR, "matches");

let current: MatchDirector | null = null;
const recentLog: string[] = [];
const log = (line: string) => {
  console.log(line);
  recentLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (recentLog.length > 200) recentLog.shift();
};

function listMatches(): MatchResult[] {
  if (!existsSync(MATCHES)) return [];
  return readdirSync(MATCHES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((f) => JSON.parse(readFileSync(join(MATCHES, f), "utf8")));
}

function listMaps(): { skirmishes: string[]; random: string[] } {
  const mods = join(REPO_ROOT, "binaries", "data", "mods", "public", "maps");
  const names = (dir: string, ext: string) => (existsSync(dir) ? [...new Set(readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)))].sort() : []);
  return { skirmishes: names(join(mods, "skirmishes"), ".xml"), random: names(join(mods, "random"), ".json").filter((n) => !/^(rmgen|rmbiome|tests|heightmap)/.test(n)) };
}

async function startMatch(card: unknown): Promise<Record<string, unknown>> {
  if (current && ["starting", "running", "finishing"].includes(current.state)) throw new Error(`match ${current.id} is still running`);
  const config = parseCard(card);
  const director = new MatchDirector(config, makeModelClient(arenaCall));
  director.on("log", log);
  current = director;
  director.run().catch((e) => log(`[match] ${e instanceof Error ? e.message : e}`));
  return { ok: true, id: director.id };
}

const server = http.createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url ?? "/", "http://x");
  const body = async () => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = join(PUBLIC, "arena_setup.html");
      if (!existsSync(page)) return send(200, { ok: true, message: "Agentium Arena API (no page yet)", api: ["/arena/status", "/arena/start", "/arena/matches", "/arena/elo"] });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(page));
    }
    if (url.pathname === "/arena/status") return send(200, { match: current?.snapshot() ?? null, log: recentLog.slice(-60), keys: keyStatus() });
    if (url.pathname === "/arena/start" && req.method === "POST") return send(200, await startMatch(JSON.parse((await body()) || "{}")));
    if (url.pathname === "/arena/stop" && req.method === "POST") {
      current?.stop("stopped");
      return send(200, { ok: true });
    }
    if (url.pathname === "/arena/matches") return send(200, listMatches());
    if (url.pathname === "/arena/elo") return send(200, readElo(ELO_PATH));
    if (url.pathname === "/arena/maps") return send(200, listMaps());
    if (url.pathname === "/arena/keys" && req.method === "GET") return send(200, keyStatus());
    const keyPath = /^\/arena\/keys\/([a-z]+)$/.exec(url.pathname);
    if (keyPath && req.method === "PUT") {
      saveProviderKey(keyPath[1], await body());
      fetchModels(keyPath[1]);
      return send(200, { ok: true, keys: keyStatus() });
    }
    if (url.pathname === "/arena/models") {
      const p = url.searchParams.get("provider") ?? "anthropic";
      if (url.searchParams.get("refresh")) await fetchModels(p);
      return send(200, { providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]: [string, any]) => [k, v.name])), provider: p, models: models(p) });
    }
    const replay = /^\/replays\/([\w-]+)\/commands\.txt$/.exec(url.pathname);
    if (replay) {
      const m = listMatches().find((x) => x.id === replay[1]);
      if (!m?.commandsTxt || !existsSync(m.commandsTxt)) return send(404, { error: "no replay" });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${replay[1]}-commands.txt"` });
      return res.end(readFileSync(m.commandsTxt));
    }
    const watch = /^\/arena\/replay\/([\w-]+)\/watch$/.exec(url.pathname);
    if (watch && req.method === "POST") {
      const m = listMatches().find((x) => x.id === watch[1]);
      if (!m?.commandsTxt || !existsSync(m.commandsTxt)) return send(404, { error: "no replay" });
      watchReplay(m.commandsTxt).unref();
      return send(200, { ok: true });
    }
    return send(404, { error: "not found" });
  } catch (e) {
    return send(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

startGateway();
server.listen(PORT, "127.0.0.1", () => console.log(`Agentium Arena: http://127.0.0.1:${PORT}`));
