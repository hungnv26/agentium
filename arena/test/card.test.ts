import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCard, playerId } from "../src/card.ts";
import { gameAttributes } from "../src/game/attributes.ts";

test("parseCard fills defaults and validates", () => {
  const c = parseCard({ map: "maps/skirmishes/acropolis_bay_2p", players: [{ controller: "model", model: "anthropic:claude-haiku-5-5", civ: "athen", cap: "0.5" }, { controller: "petra", difficulty: 4, civ: "rome" }], minutes: "10", speed: "2" });
  assert.equal(c.map, "skirmishes/acropolis_bay_2p");
  assert.equal(c.mapType, "skirmish");
  assert.equal(c.minutes, 10);
  assert.equal(c.speed, 2);
  assert.equal(c.pacing, "realtime");
  assert.equal(c.headless, true);
  assert.equal(c.players[0].cap, 0.5);
  assert.equal(c.players[1].difficulty, 4);
  assert.equal(playerId(c.players[0]), "anthropic:claude-haiku-5-5");
  assert.equal(playerId(c.players[1]), "petra:4");
  assert.equal(parseCard({ map: "random/alpine_lakes", players: [{ controller: "petra" }, { controller: "petra" }] }).mapType, "random");
  assert.throws(() => parseCard({ players: [{ controller: "petra" }] }), /at least two/);
  assert.throws(() => parseCard({ players: [{ controller: "petra", civ: "elves" }, { controller: "petra" }] }), /unknown civ/);
  assert.throws(() => parseCard({ players: [{ controller: "model", model: "haiku" }, { controller: "petra" }] }), /provider:model/);
});

test("gameAttributes matches the replay start line shape", () => {
  const c = parseCard({ map: "skirmishes/acropolis_bay_2p", players: [{ controller: "model", model: "openai:gpt-5", civ: "athen" }, { controller: "petra", civ: "rome", difficulty: 3 }], seed: 7 });
  const a = gameAttributes(c, true) as any;
  assert.equal(a.map, "maps/skirmishes/acropolis_bay_2p");
  assert.equal(a.mapType, "skirmish");
  assert.equal(a.gameSpeed, 1);
  assert.equal(a.settings.Seed, 7);
  assert.deepEqual(a.settings.VictoryConditions, ["conquest"]);
  assert.equal(a.settings.TriggerScripts[0], "scripts/NonVisualTrigger.js");
  assert.equal(a.settings.PlayerData.length, 2);
  assert.equal(a.settings.PlayerData[0].AI, "");
  assert.equal(a.settings.PlayerData[0].Civ, "athen");
  assert.equal(a.settings.PlayerData[1].AI, "petra");
  assert.equal(a.settings.PlayerData[1].AIDiff, 3);
  const visual = gameAttributes(c, false) as any;
  assert.equal(visual.settings.TriggerScripts[0], "scripts/TriggerHelper.js");
  const random = gameAttributes(parseCard({ map: "random/alpine_lakes", players: [{ controller: "petra" }, { controller: "petra" }], size: 128 }), true) as any;
  assert.equal(random.script, "alpine_lakes.js");
  assert.equal(random.settings.Size, 128);
});
