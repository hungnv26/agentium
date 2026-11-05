// A match card: what the setup page or the CLI asks for, checked and filled with defaults.
import { CIVS, pickRandomCivs, pickRandomMap } from "./game/attributes.ts";

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

// "battle": every player starts in the city phase with all technologies, full resources and no
// housing limit (maps/scripts/AgentiumBattle.js), so the match is only about fighting.
// "standard": a normal game from the village phase.
export type MatchMode = "battle" | "standard";
export const BATTLE_RESOURCES = 50_000;
// "random" as a card's map picks one of the land random maps (and one of its biomes) when the
// match is set up; "random" as a player's civ picks a civilisation. Both are the defaults, and
// the match config always holds what was picked.
export const RANDOM = "random";
export const DEFAULT_MAP = RANDOM;

export interface MatchConfig {
  mode: MatchMode;
  map: string; // "random/mainland" or "skirmishes/acropolis_bay_2p"
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
  // The ending of a watched match: the game freezes on its last moment for `endHoldSeconds`,
  // then fades to black over `endFadeSeconds`, then the window closes. 0 and 0 closes at once.
  endHoldSeconds: number;
  endFadeSeconds: number;
}

export const DEFAULT_MINUTES = 20;
export const DEFAULT_BUDGET = 1_200_000;
export const DEFAULT_END_HOLD_S = 5;
export const DEFAULT_END_FADE_S = 2.5;
const seconds = (v: unknown, fallback: number, max: number) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? fallback : Math.min(max, Math.max(0, Number(v))));

export function parseCard(input: any): MatchConfig {
  if (!input || typeof input !== "object") throw new Error("card must be an object");
  const asked = String(input.map || DEFAULT_MAP).replace(/^maps\//, "");
  const picked = asked === RANDOM ? pickRandomMap() : null;
  const map = picked?.map ?? asked;
  const biome = input.biome ? String(input.biome) : picked?.biome;
  const mode: MatchMode = input.mode === "standard" ? "standard" : "battle";
  const mapType = (input.mapType as MatchConfig["mapType"]) ?? (map.startsWith("random/") ? "random" : map.startsWith("scenarios/") ? "scenario" : "skirmish");
  const players: PlayerConfig[] = (Array.isArray(input.players) ? input.players : []).map((p: any, i: number) => {
    const controller: Controller = p.controller === "petra" || p.controller === "none" ? p.controller : "model";
    const civ = String(p.civ || RANDOM);
    if (civ !== RANDOM && !CIVS.includes(civ)) throw new Error(`unknown civ "${civ}" (random, ${CIVS.join(", ")})`);
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
  const randomCivs = pickRandomCivs(players.filter((p) => p.civ === RANDOM).length, players.map((p) => p.civ).filter((c) => c !== RANDOM));
  for (const p of players) if (p.civ === RANDOM) p.civ = randomCivs.shift()!;
  if (players.length < 2) throw new Error("a match needs at least two players");
  if (players.length > 8) throw new Error("at most eight players");
  const speed = input.speed === undefined ? 1 : Math.max(0, Number(input.speed) || 0);
  return {
    mode,
    map,
    mapType,
    players,
    minutes: Math.max(1, Math.min(180, Number(input.minutes) || DEFAULT_MINUTES)),
    speed,
    pacing: input.pacing === "turnbased" ? "turnbased" : "realtime",
    headless: input.headless !== false && input.headless !== "false",
    seed: input.seed === undefined || input.seed === "" ? Math.floor(Math.random() * 1e9) : Number(input.seed),
    ...(input.size ? { size: Number(input.size) } : {}),
    ...(biome ? { biome } : {}),
    ...(input.exploreMap ? { exploreMap: true } : {}),
    ...(input.populationCap ? { populationCap: Number(input.populationCap) } : {}),
    startingResources: Number(input.startingResources) || (mode === "battle" ? BATTLE_RESOURCES : 300),
    turnSeconds: Math.max(2, Number(input.turnSeconds) || 7),
    endHoldSeconds: seconds(input.endHoldSeconds, DEFAULT_END_HOLD_S, 120),
    endFadeSeconds: seconds(input.endFadeSeconds, DEFAULT_END_FADE_S, 30),
  };
}

// The id a player is scored under: the model spec, or "petra:<difficulty>".
export function playerId(p: PlayerConfig): string {
  return p.controller === "model" ? p.model! : p.controller === "petra" ? `petra:${p.difficulty ?? 3}` : "none";
}
