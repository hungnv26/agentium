// What a model sees each turn: the simulation's compact view (AgentiumView), plus what the
// driver remembers between turns: enemy structures it has seen (the simulation only reports the
// ones still in the fog's memory), and its own losses since the last turn.

export interface SideMemory {
  enemyStructures: Map<string, { owner: number; name: string; cell: string; time_s: number }>;
  lastUnits: Map<string, number>;
  lastTime: number;
}

export function newMemory(): SideMemory {
  return { enemyStructures: new Map(), lastUnits: new Map(), lastTime: 0 };
}

// Updates the memory from a fresh view and returns what changed since the last turn.
export function remember(view: Record<string, any>, memory: SideMemory): { losses: string[]; enemyStructuresKnown: string[] } {
  const now = Number(view.time_s ?? 0);
  for (const g of view.enemy_structures_known ?? []) {
    for (const cell of g.cells ?? []) memory.enemyStructures.set(`${g.owner}:${g.name}:${cell}`, { owner: g.owner, name: g.name, cell, time_s: now });
  }
  const units = new Map<string, number>();
  for (const g of view.units ?? []) units.set(g.name, (units.get(g.name) ?? 0) + Number(g.n ?? 0));
  const losses: string[] = [];
  for (const [name, n] of memory.lastUnits) {
    const left = units.get(name) ?? 0;
    if (left < n) losses.push(`${n - left} ${name}`);
  }
  memory.lastUnits = units;
  memory.lastTime = now;
  const enemyStructuresKnown = [...memory.enemyStructures.values()]
    .sort((a, b) => b.time_s - a.time_s)
    .slice(0, 12)
    .map((s) => `player ${s.owner} ${s.name} at ${s.cell}${now - s.time_s > 30 ? ` (seen ${Math.round((now - s.time_s) / 60)} min ago)` : ""}`);
  return { losses, enemyStructuresKnown };
}

export function turnText(view: Record<string, any>, results: string[], memory: SideMemory, firstTurn: boolean): string {
  const { losses, enemyStructuresKnown } = remember(view, memory);
  const v: Record<string, unknown> = { ...view };
  delete v.player;
  delete v.state;
  if (!(v.enemy_structures_known as any[])?.length) delete v.enemy_structures_known;
  if (enemyStructuresKnown.length) v.enemy_structures_known = enemyStructuresKnown;
  if (!(v.enemy_units_visible as any[])?.length) delete v.enemy_units_visible;
  if (!(v.incoming_attacks as any[])?.length) delete v.incoming_attacks;
  if (!(v.production as any[])?.length) delete v.production;
  if (!(v.research_in_progress as any[])?.length) delete v.research_in_progress;
  if (losses.length) v.losses_since_last_turn = losses;
  const lines = ["Your situation now (JSON):", JSON.stringify(v)];
  lines.push("", firstTurn ? "This is your first turn." : results.length ? `Results of your last orders:\n- ${results.join("\n- ")}` : "No orders were given last turn.");
  lines.push("", "Give your orders now with the tools.");
  return lines.join("\n");
}
