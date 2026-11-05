import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Commander, type ChatResult, type GameLink, type ModelClient, type TurnLog } from "../src/commander.ts";
import { readElo, updateElo } from "../src/elo.ts";
import { SYSTEM_PROMPT, TOOL_NAMES } from "../src/orders.ts";
import { newMemory, remember, turnText } from "../src/view.ts";

const view = (time_s: number, extra: Record<string, unknown> = {}) => ({
  time_s,
  player: 1,
  civ: "athen",
  phase: "village",
  pop: "7/20",
  resources: { food: 300, wood: 300, stone: 300, metal: 300 },
  state: "active",
  cc: { id: 20, cell: "J10" },
  units: [{ name: "support_civilian", n: 3, cells: ["J10"], doing: { idle: 3 } }],
  idle: { workers: 3, military: 0 },
  structures: [],
  production: [],
  enemy_units_visible: [],
  enemy_structures_known: [],
  incoming_attacks: [],
  options: { train: [], build: [], research: [] },
  ...extra,
});

test("memory keeps enemy structures and reports losses", () => {
  const m = newMemory();
  remember(view(10, { enemy_structures_known: [{ owner: 2, name: "civil_centre", n: 1, cells: ["C3"] }], units: [{ name: "infantry_spearman_b", n: 10, cells: ["J10"] }] }), m);
  const r = remember(view(200, { units: [{ name: "infantry_spearman_b", n: 6, cells: ["H8"] }] }), m);
  assert.deepEqual(r.losses, ["4 infantry_spearman_b"]);
  assert.match(r.enemyStructuresKnown[0], /player 2 civil_centre at C3 \(seen 3 min ago\)/);
  const text = turnText(view(200), ["train(unit=x): done: ok"], m, false);
  assert.match(text, /Your situation now/);
  assert.match(text, /Results of your last orders:\n- train/);
  assert.doesNotMatch(text, /"player":1/);
});

test("the commander takes a turn, carries out orders, and stops when out of budget", async () => {
  const orders: { player: number; name: string; args: Record<string, unknown> }[] = [];
  let observed = 0;
  const link: GameLink = {
    observe: async () => {
      observed++;
      return view(observed * 10);
    },
    order: async (player, name, args) => {
      orders.push({ player, name, args });
      return name === "build" ? { ok: false, message: "build: no site" } : { ok: true, message: `${name} done` };
    },
    waitTurn: async () => {},
  };
  const client: ModelClient = {
    async chat(model, body): Promise<ChatResult> {
      assert.equal(model, "test:model");
      assert.equal((body.tools as any[]).length, TOOL_NAMES.length);
      assert.match(String((body.messages as any[])[0].content), /0 A\.D\./);
      return {
        message: {
          content: null,
          tool_calls: [
            { function: { name: "train", arguments: JSON.stringify({ unit: "support_civilian", count: 2 }) } },
            { function: { name: "build", arguments: JSON.stringify({ structure: "house" }) } },
            { function: { name: "move", arguments: JSON.stringify({ units: "4,5", to: "C4" }) } },
          ],
        },
        tokens: 600,
        usd: 0.001,
        finish: "tool_calls",
      };
    },
  };
  const c = new Commander({ player: 1, name: "Tester", civ: "athen", model: "test:model", budget: 1000, minutes: 10 }, link, client);
  const logs: TurnLog[] = [];
  c.on("log", (t) => logs.push(t));
  await c.start();
  // 1000 tokens of budget: the first turn costs 600, the second would pass the budget check (600 < 1000) and cost 600 more, then it stops.
  assert.equal(c.status, "out of budget");
  assert.equal(c.turns, 2);
  assert.equal(c.tokens, 1200);
  assert.equal(c.orders, 6);
  assert.equal(c.refused, 2);
  assert.deepEqual(orders[2].args, { units: [4, 5], to: "C4" });
  assert.equal(logs.length, 2);
  assert.match(logs[0].results[1], /build\(structure=house\): refused: build: no site/);
  assert.match(logs[1].prompt, /Results of your last orders/);
  const s = c.stats();
  assert.equal(s.usd, 0.002);
  assert.equal(s.lastOrders.length, 3);
});

test("a defeated player stops its commander", async () => {
  const link: GameLink = { observe: async () => view(5, { state: "defeated" }), order: async () => ({ ok: true, message: "" }), waitTurn: async () => {} };
  const client: ModelClient = { chat: async () => ({ message: {}, tokens: 1 }) };
  const c = new Commander({ player: 2, name: "x", civ: "rome", model: "test:m", budget: 1000, minutes: 5 }, link, client);
  await c.start();
  assert.equal(c.status, "defeated");
  assert.equal(c.turns, 0);
});

test("battle mode gets the fighting briefing", () => {
  const battle = SYSTEM_PROMPT("X", "athen", 15, "battle");
  assert.match(battle, /battle match/);
  assert.match(battle, /50,000 of each resource/);
  assert.doesNotMatch(battle, /Four resources/);
  assert.match(SYSTEM_PROMPT("X", "athen", 15), /Four resources/);
});

test("elo rewards the winner", () => {
  const path = join(mkdtempSync(join(tmpdir(), "elo-")), "elo.json");
  updateElo(path, "a:x", ["petra:3"]);
  const t = readElo(path);
  assert.equal(t["a:x"].rating, 1016);
  assert.equal(t["petra:3"].rating, 984);
  assert.equal(t["a:x"].wins, 1);
  updateElo(path, null, ["a:x", "petra:3"]);
  assert.equal(readElo(path)["a:x"].matches, 1);
  updateElo(path, "petra:3", ["petra:3"]);
  assert.equal(readElo(path)["petra:3"].matches, 1);
});
