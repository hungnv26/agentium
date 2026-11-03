// Elo per player id ("anthropic:claude-haiku-5-5", "petra:3"), kept in .data/elo.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EloEntry {
  rating: number;
  matches: number;
  wins: number;
}

export function readElo(path: string): Record<string, EloEntry> {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

// The winner beats each loser (a draw updates nothing). Returns the table after the update.
export function updateElo(path: string, winner: string | null, losers: string[], k = 32): Record<string, EloEntry> {
  const table = readElo(path);
  const r = (id: string) => table[id]?.rating ?? 1000;
  if (winner)
    for (const l of losers) {
      if (winner === l) continue;
      const ew = 1 / (1 + 10 ** ((r(l) - r(winner)) / 400));
      table[winner] = { rating: Math.round(r(winner) + k * (1 - ew)), matches: (table[winner]?.matches ?? 0) + 1, wins: (table[winner]?.wins ?? 0) + 1 };
      table[l] = { rating: Math.round(r(l) - k * (1 - ew)), matches: (table[l]?.matches ?? 0) + 1, wins: table[l]?.wins ?? 0 };
    }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(table, null, 2));
  return table;
}
