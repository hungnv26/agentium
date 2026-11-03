// A match card: what the setup page or the CLI asks for, checked and filled with defaults.
import { CIVS } from "./game/attributes.ts";

export type Controller = "model" | "petra" | "none";

export interface PlayerConfig {
  controller: Controller;
  civ: string;
  name?: string;
  team?: number; // -1 for none
  // model players
  model?: string; // "provider:model"
  budget?: number; // tokens
  cap?: number | null; // USD
  // petra
  difficulty?: number; // 0..5
  behavior?: "random" | "balanced" | "aggressive" | "defensive";
}

export interface MatchConfig {
  map: string; // "skirmishes/acropolis_bay_2p" or "random/alpine_lakes"
  mapType: "skirmish" | "scenario" | "random";
  players: PlayerConfig[];
  minutes: number; // game minutes before the time limit
  speed: number; // ticks per 200 ms of wall time: 1 = real time, 0 = as fast as possible
  pacing: "realtime" | "turnbased";
  headless: boolean;
  seed?: number;
  size?: number;
  biome?: string;
  exploreMap?: boolean;
  populationCap?: number;
  startingResources?: number;
  turnSeconds?: number; // game seconds between a model's turns (default 7)
}

export const DEFAULT_MINUTES = 20;
export const DEFAULT_BUDGET = 1_200_000;

export function parseCard(input: any): MatchConfig {
  if (!input || typeof input !== "object") throw new Error("card must be an object");
  const map = String(input.map ?? "skirmishes/acropolis_bay_2p").replace(/^maps\//, "");
  const mapType = (input.mapType as MatchConfig["mapType"]) ?? (map.startsWith("random/") ? "random" : map.startsWith("scenarios/") ? "scenario" : "skirmish");
  const players: PlayerConfig[] = (Array.isArray(input.players) ? input.players : []).map((p: any, i: number) => {
    const controller: Controller = p.controller === "petra" || p.controller === "none" ? p.controller : "model";
    const civ = String(p.civ ?? CIVS[i % CIVS.length]);
    if (!CIVS.includes(civ)) throw new Error(`unknown civ "${civ}" (${CIVS.join(", ")})`);
    const out: PlayerConfig = { controller, civ, team: Number.isInteger(p.team) ? p.team : -1 };
    if (p.name) out.name = String(p.name);
    if (controller === "model") {
      out.model = String(p.model ?? "anthropic:claude-haiku-5-5");
      if (!/^[a-z]+:.+/.test(out.model)) throw new Error(`model must be provider:model, got "${out.model}"`);
      out.budget = Math.max(10_000, Number(p.budget) || DEFAULT_BUDGET);
      out.cap = p.cap === null || p.cap === undefined || p.cap === "" ? null : Math.max(0.01, Number(p.cap));
    } else if (controller === "petra") {
      out.difficulty = Math.min(5, Math.max(0, Math.round(Number(p.difficulty ?? 3))));
      out.behavior = ["random", "balanced", "aggressive", "defensive"].includes(p.behavior) ? p.behavior : "balanced";
    }
    return out;
  });
  if (players.length < 2) throw new Error("a match needs at least two players");
  if (players.length > 8) throw new Error("at most eight players");
  const speed = input.speed === undefined ? 1 : Math.max(0, Number(input.speed) || 0);
  return {
    map,
    mapType,
    players,
    minutes: Math.max(1, Math.min(180, Number(input.minutes) || DEFAULT_MINUTES)),
    speed,
    pacing: input.pacing === "turnbased" ? "turnbased" : "realtime",
    headless: input.headless !== false && input.headless !== "false",
    seed: input.seed === undefined || input.seed === "" ? Math.floor(Math.random() * 1e9) : Number(input.seed),
    ...(input.size ? { size: Number(input.size) } : {}),
    ...(input.biome ? { biome: String(input.biome) } : {}),
    ...(input.exploreMap ? { exploreMap: true } : {}),
    ...(input.populationCap ? { populationCap: Number(input.populationCap) } : {}),
    ...(input.startingResources ? { startingResources: Number(input.startingResources) } : {}),
    turnSeconds: Math.max(2, Number(input.turnSeconds) || 7),
  };
}

// The id a player is scored under: the model spec, or "petra:<difficulty>".
export function playerId(p: PlayerConfig): string {
  return p.controller === "model" ? p.model! : p.controller === "petra" ? `petra:${p.difficulty ?? 3}` : "none";
}
