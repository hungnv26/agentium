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
    RlClient: /reset /step /evaluate /outro /stop       (src/game/rl.ts)
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
node src/cli.ts --p1 petra:3 --p2 petra:3 --minutes 15 --speed 0          # battle mode on a random map, as fast as possible
node src/cli.ts --mode standard --map skirmishes/acropolis_bay_2p --p1 petra:3 --p2 petra:3   # a normal game
node src/cli.ts --p1 anthropic:claude-haiku-5-5 --civ1 athen --p2 petra:3 --minutes 10 --cap 0.5
node src/cli.ts --p1 anthropic:claude-sonnet-5-5 --p2 openai:gpt-5 --pacing turnbased --visual
node src/server.ts                                                         # http://127.0.0.1:8896
npm test
```

Players: `petra[:difficulty]`, `provider:model`, or `none`. `--speed N` is turns per 200 ms of
wall time (1 = real time, 0 = fastest); `--visual` opens a game window as an observer.

## Modes

- **battle** (default): every player starts in the city phase with every technology researched,
  50,000 of each resource and no housing limit (`maps/scripts/AgentiumBattle.js`, a trigger script,
  so replays stay valid). No farming or mining: the match is about building an army and fighting,
  and at the time limit the score is the value of enemy units killed and buildings destroyed.
- **standard**: a normal game from the village phase with 300 of each resource, scored by
  resources gathered plus kills.

By default the map and every player's civilisation are random: the card values `map: "random"`
and `civ: "random"` (also what a missing value means) are picked when the match is set up, and
the match record holds what was picked. The map comes from the random maps that play as a land
fight (not the naval, trigger or demo ones), with one of its biomes, at size Small; random
civilisations differ from each other. `node tools/check_maps.ts` checks that every map in that
pool generates and joins the two civic centres by land. Choose a map or a civilisation to fix
it (`--map random/mainland`, `--civ1 athen`). The setup page opens a game window as an observer
by default, the CLI stays headless unless `--visual` is given.

## How a watched match ends

When a match in a game window runs its course (conquest or the time limit), the game freezes on
its last moment for 5 seconds, then the picture and the sound fade out over 2.5 seconds, and only
then the window closes. The Arena asks for this with `/outro?hold=S&fade=S` on the RL interface;
the session page does the rest (`gui/session/outro/`). The lengths are the card fields
`endHoldSeconds` and `endFadeSeconds` (`--end-hold`, `--end-fade` on the CLI); 0 and 0 closes the
window at once. A match stopped by hand closes at once, and Stop during the ending cuts it short.

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

## In-game advisor

The same model, prompt and tools can advise a human player from inside the game. The engine's
HTTP bridge (`Engine.HttpRequestStart/Poll`) is off by default; turn it on in the user config
(`~/Library/Application Support/agentium/config/user.cfg`) with the token the gateway prints
(the setup page's Advisor section shows the exact lines):

```
http.enabled = "true"
advisor.enabled = "true"
advisor.token = "<arena/.data/arena.token>"
advisor.model = "anthropic:claude-haiku-5-5"   ; optional
advisor.interval = "45"                        ; seconds between automatic turns, 0 = only on request
```

Run `node src/server.ts`, start a single-player game, and press the Advisor button under the
top panel: the panel shows the model's note and up to six suggested orders, each with Apply.
Applied orders go through the same resolver as the Arena's commanders and are recorded in the
replay. Only the local player can apply; observers get a read-only view.
