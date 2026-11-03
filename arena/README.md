# Agentium Arena

AI models play Agentium (0 A.D.) as players, against each other or against the game's built-in
Petra AI. Matches are driven through the engine's RL interface, recorded as replays, scored and
rated (Elo), with every model's prompts, orders and cost logged.

Requires Node 24 (TypeScript runs directly) and the game built at `binaries/system/pyrogenesis`.

## How it works

```
arena/src/server.ts (:8896)  ── setup page + API; starts the key gateway (:8895)
  MatchDirector (src/match.ts)
    GameProcess: pyrogenesis -rl-interface=127.0.0.1:770n [-autostart-nonvisual]
    RlClient: /reset /step /evaluate /stop              (src/game/rl.ts)
    the clock: POST /step every 200 ms (speed turns per tick), with every queued command
    one Commander per model player (src/commander.ts)
      observe = AgentiumView(player)        (binaries/data/mods/public/simulation/helpers/AgentiumView.js)
      order   = AgentiumResolve(player, …)  (…/AgentiumOrders.js) → Commands.js payloads → next /step
    ModelClient → gateway.mjs → Anthropic / OpenAI / OpenRouter / Ollama
```

The engine only advances inside `/step`, so the director owns the clock. Model players run
asynchronously: a slow model loses tempo, the game never waits (`pacing: realtime`). With
`pacing: turnbased` the clock pauses every `turnSeconds` of game time until each live model has
answered. Petra opponents advance inside the same turns. Commands always go through the turn
manager, so the replay is complete and plays back with `pyrogenesis -replay=<commands.txt>`.

## Running

```sh
cd arena
node src/cli.ts --p1 petra:3 --p2 petra:3 --minutes 15 --speed 0          # baseline, as fast as possible
node src/cli.ts --p1 anthropic:claude-haiku-5-5 --civ1 athen --p2 petra:3 --minutes 10 --cap 0.5
node src/cli.ts --p1 anthropic:claude-sonnet-5-5 --p2 openai:gpt-5 --pacing turnbased --visual
node src/server.ts                                                         # http://127.0.0.1:8896
npm test
```

Players: `petra[:difficulty]`, `provider:model`, or `none`. `--speed N` is turns per 200 ms of
wall time (1 = real time, 0 = fastest); `--visual` opens a game window as an observer.

## Keys and cost

Provider keys are files: `arena/keys/<provider>.key` (gitignored), or set `ARENA_KEYS_DIR`
(for example to Outpost Zero's `infra/keys`). Each model call is priced from
`design/model_prices.json`; a player stops giving orders at its token budget or its cost cap.

## Output

- `.data/matches/<id>.json`: the result (winner, reason, scores, per-model stats, replay path)
- `.data/elo.json`: ratings per player id (`anthropic:claude-haiku-5-5`, `petra:3`)
- `match-logs/<id>/p<N>.md` and `.jsonl`: every turn's prompt, reply, orders and results
- the replay under `~/Library/Application Support/agentium/replays/<version>/<date>/`

## Orders

`gather`, `train`, `build`, `research`, `phase_up`, `attack`, `move`, `retreat`, `garrison`,
`set_rallypoint`, `stance`: defined once in `src/orders.ts` (prompt and tool schemas) and carried
out by `AgentiumResolve` in the simulation, which refuses with a reason naming what is available.
