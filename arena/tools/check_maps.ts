// Checks every map a "random" card can pick (randomMapPool): the map generates for two players,
// both get a civic centre, and the two civic centres are joined by land (a coarse flood fill
// over ground no deeper under water than a soldier can wade, and no steeper than they can climb).
//   node tools/check_maps.ts [map ...]        (default: the whole pool; prints one line per map)
import { parseCard } from "../src/card.ts";
import { gameAttributes, randomMapPool } from "../src/game/attributes.ts";
import { GameProcess } from "../src/game/process.ts";

const LAND_CHECK = `
  const cmpTerrain = Engine.QueryInterface(SYSTEM_ENTITY, IID_Terrain);
  const cmpWater = Engine.QueryInterface(SYSTEM_ENTITY, IID_WaterManager);
  const size = cmpTerrain.GetMapSize(), step = 4, n = Math.floor(size / step);
  const ccs = [1, 2].map(p => { const e = AgentiumCivicCentre(p); const c = e && Engine.QueryInterface(e, IID_Position); return c ? c.GetPosition2D() : null; });
  if (!ccs[0] || !ccs[1]) return { cc: false };
  const h = new Float32Array(n * n), ok = new Uint8Array(n * n);
  for (let j = 0; j < n; ++j) for (let i = 0; i < n; ++i) {
    const x = (i + 0.5) * step, z = (j + 0.5) * step, g = cmpTerrain.GetGroundLevel(x, z);
    h[j * n + i] = g; ok[j * n + i] = cmpWater.GetWaterLevel(x, z) - g <= 2 ? 1 : 0;
  }
  const cell = p => Math.min(n - 1, Math.floor(p.y / step)) * n + Math.min(n - 1, Math.floor(p.x / step));
  const from = cell(ccs[0]), to = cell(ccs[1]);
  const seen = new Uint8Array(n * n), queue = [from]; seen[from] = 1;
  for (let q = 0; q < queue.length; ++q) {
    const c = queue[q], i = c % n, j = (c - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const d = b * n + a;
      if (seen[d] || !ok[d] || Math.abs(h[d] - h[c]) > step) continue;
      seen[d] = 1; queue.push(d);
    }
  }
  return { cc: true, joined: !!seen[to], distance: Math.round(Math.hypot(ccs[0].x - ccs[1].x, ccs[0].y - ccs[1].y)) };
`;

const maps = process.argv.slice(2).length ? process.argv.slice(2) : randomMapPool();
let port = Number(process.env.RL_BASE_PORT ?? 7760);
let game: GameProcess | null = null;
const bad: string[] = [];
for (const name of maps) {
  const t0 = Date.now();
  try {
    if (!game?.running) {
      game = new GameProcess({ port: port++, headless: true });
      await game.start();
    }
    const config = parseCard({ map: `random/${name}`, players: [{ controller: "petra" }, { controller: "petra" }], seed: 11 });
    await game.client.reset(gameAttributes(config, true), { saveReplay: false, playerID: 1 });
    await game.client.step([], 5);
    const r = await game.client.evaluate<{ cc: boolean; joined?: boolean; distance?: number }>(LAND_CHECK);
    const good = r.cc && r.joined;
    if (!good) bad.push(name);
    console.log(`${good ? "ok  " : "BAD "} ${name.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${JSON.stringify(r)}`);
  } catch (e) {
    bad.push(name);
    console.log(`FAIL ${name.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${e instanceof Error ? e.message : e}`);
    await game?.kill().catch(() => {});
    game = null;
  }
}
await game?.client.stop();
await game?.kill();
console.log(`\n${maps.length - bad.length} of ${maps.length} maps ok${bad.length ? `; not ok: ${bad.join(", ")}` : ""}`);
