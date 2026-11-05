// Run one match from the command line and print the result. Defaults: battle mode (city phase,
// all technologies, full resources) on the random map Mainland; --mode standard for a normal game.
//   node src/cli.ts --p1 petra:3 --p2 petra:3 --minutes 15 --speed 0
//   node src/cli.ts --mode standard --map skirmishes/acropolis_bay_2p --p1 petra:3 --p2 petra:3
//   node src/cli.ts --p1 anthropic:claude-haiku-5-5 --civ1 athen --p2 petra:3 --minutes 10 --cap 0.5
// Players: "petra[:difficulty]", "provider:model", or "none". --visual opens a game window;
// --pacing turnbased waits for every model each turn; --speed N turns per 200 ms (0 = fastest).
import { arenaCall } from "../gateway.mjs";
import { parseCard } from "./card.ts";
import { makeModelClient, MatchDirector } from "./match.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) args.set(a.slice(2, eq), a.slice(eq + 1));
  else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.set(a.slice(2), argv[++i]);
  else args.set(a.slice(2), "true");
}

const players = [];
for (let i = 1; i <= 8; i++) {
  const spec = args.get(`p${i}`);
  if (!spec) continue;
  const civ = args.get(`civ${i}`);
  const team = args.get(`team${i}`);
  if (spec === "none") players.push({ controller: "none", civ, team });
  else if (spec.startsWith("petra")) players.push({ controller: "petra", civ, team, difficulty: Number(spec.split(":")[1] ?? 3), behavior: args.get(`behavior${i}`) });
  else players.push({ controller: "model", civ, team, model: spec, budget: args.get("budget"), cap: args.get("cap") ?? null, name: args.get(`name${i}`) });
}
if (players.length < 2) {
  players.push({ controller: "petra", difficulty: 3 }, { controller: "petra", difficulty: 3 });
}

const config = parseCard({
  mode: args.get("mode"),
  map: args.get("map"),
  players,
  minutes: args.get("minutes") ?? 15,
  speed: args.get("speed") ?? (players.some((p) => p.controller === "model") ? 1 : 0),
  pacing: args.get("pacing"),
  headless: !args.has("visual"),
  seed: args.get("seed"),
  size: args.get("size"),
  biome: args.get("biome"),
  turnSeconds: args.get("turn-seconds"),
});

const director = new MatchDirector(config, makeModelClient(arenaCall));
director.on("log", (line: string) => console.log(line));
let lastShown = -1;
director.on("status", (s: any) => {
  if (s.state !== "running") return;
  const line = `[match] game ${Math.floor(s.gameTime / 60)}:${String(Math.round(s.gameTime % 60)).padStart(2, "0")} turn ${s.turn} wall ${s.wallSeconds}s`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line}   `);
  else if (Math.floor(s.gameTime / 60) > lastShown) {
    lastShown = Math.floor(s.gameTime / 60);
    console.log(line);
  }
});
process.on("SIGINT", () => director.stop("stopped"));

const result = await director.run();
console.log("\n" + JSON.stringify({ ...result, players: result.players.map((p) => ({ ...p, statistics: undefined })) }, null, 2));
process.exit(result.reason === "failed" ? 1 : 0);
