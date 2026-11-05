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

// The biome a random map plays in: the card's, else the first the map supports (a prefix such
// as "alpine/" means every biome in maps/random/rmbiome/alpine/), else none.
export function defaultBiome(settings: Record<string, any>, wanted?: string): string | undefined {
  if (wanted) return wanted;
  const supported = settings.SupportedBiomes;
  if (Array.isArray(supported) && supported.length) return String(supported[0]);
  if (typeof supported === "string" && supported) {
    if (!supported.endsWith("/")) return supported;
    const dir = join(MAPS, "random", "rmbiome", supported);
    const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    return names.length ? supported + names[0].slice(0, -5) : undefined;
  }
  return undefined;
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
