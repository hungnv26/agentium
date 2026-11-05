// Prompt logs: match-logs/<match id>/ (gitignored): match.json (setup, result, each model's
// totals), and per model player p<N>.jsonl (one line per turn: the prompt, the model's reply and
// tool calls, each order's result, tokens, time) and p<N>.md (the same as a readable transcript).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchConfig } from "./card.ts";
import type { TurnLog } from "./commander.ts";
import { SYSTEM_PROMPT, TOOLS } from "./orders.ts";

export class MatchLogs {
  readonly dir: string;
  readonly id: string;
  constructor(root: string, id: string, config: MatchConfig) {
    this.id = id;
    this.dir = join(root, id);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "match.json"), JSON.stringify({ id, startedAt: new Date().toISOString(), config }, null, 2));
    config.players.forEach((p, i) => {
      if (p.controller !== "model") return;
      const player = i + 1;
      const md = [
        `# ${id}: player ${player} (${p.civ}) played by ${p.model}`,
        "",
        `Mode ${config.mode}; map ${config.map}; speed ${config.speed}x (${config.pacing}); ${config.minutes} game minutes; budget ${p.budget} tokens${p.cap != null ? `, cap $${p.cap}` : ""}.`,
        `Players: ${config.players.map((x, j) => `${j + 1} ${x.civ} (${x.controller === "model" ? x.model : x.controller === "petra" ? `petra ${x.difficulty}` : "none"})`).join(", ")}.`,
        "",
        "## System prompt",
        "",
        "```",
        SYSTEM_PROMPT(p.name ?? p.model ?? `Player ${player}`, p.civ, config.minutes, config.mode),
        "```",
        "",
        `Tools: ${TOOLS.map((t) => t.function.name).join(", ")}.`,
        "",
      ];
      writeFileSync(join(this.dir, `p${player}.md`), md.join("\n"));
      writeFileSync(join(this.dir, `p${player}.jsonl`), "");
    });
  }

  turn(player: number, t: TurnLog): void {
    appendFileSync(join(this.dir, `p${player}.jsonl`), JSON.stringify(t) + "\n");
    const calls = t.reply.tool_calls.map((c) => `- \`${c.name}(${c.arguments})\``).join("\n") || "(none)";
    const md = [
      `## Turn ${t.turn}: game ${Math.floor(t.gameTime / 60)}:${String(t.gameTime % 60).padStart(2, "0")}, ${t.at.slice(11, 19)}, ${t.seconds.toFixed(1)} s, ${t.tokens} tokens${t.cached ? ` (${t.cached} cached)` : ""}, ${t.tokensTotal} so far${t.usd != null ? `, $${t.usd.toFixed(4)}` : ""}${t.finish ? `, reply ended: ${t.finish}` : ""}`,
      "",
      t.error ? `**The call failed:** ${t.error}\n` : "",
      "<details><summary>Prompt (what the player saw)</summary>",
      "",
      "```",
      t.prompt,
      "```",
      "</details>",
      "",
      t.reply.content ? `Model wrote: ${t.reply.content}\n` : "",
      "Tool calls:",
      calls,
      "",
      "Results:",
      t.results.map((r) => `- ${r}`).join("\n") || "(none)",
      "",
    ];
    appendFileSync(join(this.dir, `p${player}.md`), md.filter((l) => l !== "").join("\n") + "\n\n");
  }

  finish(result: Record<string, unknown>): void {
    const file = join(this.dir, "match.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...record, finishedAt: new Date().toISOString(), result }, null, 2));
  }
}
