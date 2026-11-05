// Game attributes for /reset, in the shape the engine writes at the top of a replay's
// commands.txt (see simulation/helpers/InitGame.js: a player with a non-empty "AI" gets a bot).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchConfig, PlayerConfig } from "../card.ts";
import { REPO_ROOT } from "./process.ts";

const MAPS = join(REPO_ROOT, "binaries", "data", "mods", "public", "maps");

// A random map's settings from its JSON (name, biomes it supports), or {} when unknown.
export function randomMapSettings(map: string): Record<string, any> {
  const file = join(MAPS, `${map}.json`);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")).settings ?? {};
  } catch {
    return {};
  }
}

// Every biome id ("generic/alpine", "fields_of_meroe/dry", ...) in maps/random/rmbiome/.
function allBiomes(): string[] {
  const root = join(MAPS, "random", "rmbiome");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".json")).map((f) => `${d.name}/${f.slice(0, -5)}`))
    .sort();
}

// The biomes a random map supports: a list of ids, or (as in the game's own setup) a prefix
// such as "alpine/" or "generic" for every biome whose id starts with it.
export function supportedBiomes(settings: Record<string, any>): string[] {
  const supported = settings.SupportedBiomes;
  if (Array.isArray(supported)) return supported.map(String);
  if (typeof supported === "string" && supported) return allBiomes().filter((b) => b.startsWith(supported));
  return [];
}

// The biome a random map plays in: the card's, else the first the map supports, else none.
export function defaultBiome(settings: Record<string, any>, wanted?: string): string | undefined {
  return wanted || supportedBiomes(settings)[0];
}

// The maps a "random" card picks from: the random maps that play as a land fight. Left out are
// the ones the game marks naval (ships are needed to reach the enemy), trigger (their own
// events: floods, attack waves) or demo, and "unknown", which may generate islands.
const NOT_IN_POOL = new Set(["unknown"]);
export function randomMapPool(): string[] {
  const dir = join(MAPS, "random");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((name) => {
      if (NOT_IN_POOL.has(name)) return false;
      const settings = randomMapSettings(`random/${name}`);
      if (!settings.Script) return false; // biome tables and the like
      const keywords: string[] = Array.isArray(settings.Keywords) ? settings.Keywords : [];
      return !keywords.some((k) => ["naval", "trigger", "demo"].includes(k)) && !settings.TriggerScripts;
    })
    .sort();
}

const pick = <T>(list: T[], rand: () => number): T => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

// A map for a "random" card, as "random/<name>", with one of its biomes (if it has any).
export function pickRandomMap(rand: () => number = Math.random): { map: string; biome?: string } {
  const pool = randomMapPool();
  const map = `random/${pool.length ? pick(pool, rand) : "mainland"}`;
  const biomes = supportedBiomes(randomMapSettings(map));
  return { map, ...(biomes.length ? { biome: pick(biomes, rand) } : {}) };
}

// Civilisations for the players who asked for a random one: different from each other and from
// the ones already chosen while there are enough to go round.
export function pickRandomCivs(count: number, taken: string[], rand: () => number = Math.random): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const free = CIVS.filter((c) => !used.has(c));
    const civ = pick(free.length ? free : CIVS, rand);
    used.add(civ);
    out.push(civ);
  }
  return out;
}

export const PLAYER_COLORS = [
  { r: 10, g: 10, b: 190 },
  { r: 230, g: 10, b: 10 },
  { r: 50, g: 180, b: 50 },
  { r: 240, g: 200, b: 20 },
  { r: 140, g: 30, b: 180 },
  { r: 250, g: 140, b: 0 },
  { r: 30, g: 190, b: 200 },
  { r: 230, g: 90, b: 190 },
];

export const CIVS = ["athen", "brit", "cart", "gaul", "germ", "han", "iber", "kush", "mace", "maur", "pers", "ptol", "rome", "sele", "spart"];

export function playerData(p: PlayerConfig, index: number): Record<string, unknown> {
  const petra = p.controller === "petra";
  return {
    Name: p.name ?? (petra ? `Petra ${index + 1}` : p.controller === "model" ? p.model : `Player ${index + 1}`),
    Civ: p.civ,
    Color: PLAYER_COLORS[index % PLAYER_COLORS.length],
    AI: petra ? "petra" : "",
    AIDiff: petra ? p.difficulty ?? 3 : 3,
    AIBehavior: petra ? p.behavior ?? "balanced" : "balanced",
    Team: p.team ?? -1,
  };
}

export function gameAttributes(config: MatchConfig, headless: boolean): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    Ceasefire: 0,
    CheatsEnabled: false,
    CircularMap: true,
    DisableSpies: false,
    DisableTreasures: false,
    LastManStanding: false,
    LockTeams: true,
    RevealMap: false,
    ExploreMap: config.exploreMap ?? false,
    AllyView: false,
    mapName: config.map.replace(/^.*\//, ""),
    PlayerData: config.players.map(playerData),
    PopulationCapType: "player",
    PopulationCap: config.populationCap ?? 300,
    Seed: config.seed ?? 0,
    AISeed: config.seed ?? 0,
    StartingResources: config.startingResources ?? 300,
    TriggerScripts: [...(headless ? ["scripts/NonVisualTrigger.js"] : []), "scripts/TriggerHelper.js", "scripts/ConquestCommon.js", "scripts/Conquest.js", ...(config.mode === "battle" ? ["scripts/AgentiumBattle.js"] : [])],
    VictoryConditions: ["conquest"],
  };
  if (config.mapType === "random") {
    const mapSettings = randomMapSettings(config.map);
    if (mapSettings.Name) settings.mapName = mapSettings.Name;
    settings.Size = config.size ?? 192;
    const biome = defaultBiome(mapSettings, config.biome);
    if (biome) settings.Biome = biome;
    settings.Nomad = false;
    settings.PlayerPlacement = "circle";
  }
  return {
    settings,
    gameSpeed: 1,
    map: `maps/${config.map}`,
    mapType: config.mapType,
    ...(config.mapType === "random" ? { script: `${config.map.replace(/^random\//, "")}.js` } : {}),
  };
}
