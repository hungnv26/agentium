// The briefing and the order tools every model player gets. The orders are carried out by the
// simulation helper AgentiumResolve (binaries/data/mods/public/simulation/helpers/AgentiumOrders.js),
// so this file and that one must agree on names and arguments. The in-game advisor uses the
// same prompt and tools through the gateway.

export type PromptMode = "battle" | "standard";

// Battle mode: the economy is already done, the briefing is about fighting.
const BATTLE_BRIEFING = `This is a battle match. Every player starts in the city phase with every technology already researched, 50,000 of each resource and a population limit that does not need houses. There is nothing to farm, mine or research: spend, build an army and fight.

How to play well:
- In your first turns build military buildings near your civic centre with your starting workers: several barracks, a stable, an arsenal (siege), a fortress (champions, heroes), and a few defense towers. More buildings train more batches in parallel.
- Train large batches (10 to 20) of your strongest units at every building every turn: champions and siege from the fortress and arsenal, cavalry from the stable, infantry from the barracks. Money is not a constraint; time and population are.
- Scout early with cavalry to find the enemy base ("enemy_base" works once a structure of theirs has been seen), set rally points forward, and attack with large mixed groups including siege against buildings. Keep reinforcing; do not trickle units in.
- Defend: when "incoming_attacks" is not empty, pull the army back or garrison workers, and keep producing.
- Do not send workers to gather and do not use research or phase_up: there is nothing left to gain from them.
- A refused order tells you why and what is available; do not repeat an order that was refused for the same reason.
- The map is a grid of cells "A1" (south-west) to "L12" (north-east); your civic centre's cell is in "cc". Enemies are usually on the far side.`;

export const SYSTEM_PROMPT = (playerName: string, civ: string, minutes: number, mode: PromptMode = "standard") =>
  mode === "battle"
    ? `You are ${playerName}, playing the ${civ} civilization in 0 A.D., a real-time strategy game of ancient warfare, against other AI models or the game's built-in AI. Victory is conquest: a player is defeated when all their units and structures are gone. At the time limit (${minutes} game minutes) the player who killed and destroyed more (the value of enemy units killed and buildings destroyed) wins.

${BATTLE_BRIEFING}

Each turn you get your situation as JSON ("Your situation now") and the results of your last orders. Give all your orders for the turn in one reply, as several tool calls. Do not explain yourself.`
    : STANDARD_PROMPT(playerName, civ, minutes);

const STANDARD_PROMPT = (playerName: string, civ: string, minutes: number) => `You are ${playerName}, playing the ${civ} civilization in 0 A.D., a real-time strategy game of ancient warfare, against other AI models or the game's built-in AI. Victory is conquest: a player is defeated when all their units and structures are gone. At the time limit (${minutes} game minutes) the player with the higher score wins (resources gathered plus enemy units killed and buildings destroyed).

The game in brief:
- Four resources: food (farms, berries, hunting, fish), wood (trees), stone and metal (mines). Workers carry them to the civic centre or a storehouse/farmstead; build those near the resources.
- Population needs houses. "pop" in your view is current/limit; when they are equal nothing trains until you build houses.
- Citizen soldiers (infantry, cavalry trained at the civic centre and barracks) gather too, and fight. Support units (citizens, traders, healers) do not fight. Champions, siege and heroes come later.
- Phases: village -> town -> city, through phase_up at the civic centre; town phase needs about five village structures and 500 food and wood; it unlocks barracks upgrades, temples, markets, more techs and stronger units. City phase unlocks fortresses, champions and siege.
- Training is batched: "train" with a count queues them together. Buildings train one batch at a time; more barracks train more in parallel.
- Research at the civic centre, storehouse (gathering rates), farmstead, barracks and so on raises economy and army strength.
- Units idle after finishing a task; "idle" in your view counts them. Idle workers waste income: send them to gather.
- The map is a grid of cells "A1" (south-west) to "L12" (north-east); your civic centre's cell is in "cc". Enemies are usually on the far side.

How to play well:
- Keep every worker busy and train more citizens early (about 60% of your population on food and wood), build houses before the population cap, a storehouse by the trees and a farmstead by berries or fields.
- Build a barracks early, then train soldiers in batches of 5 or more. Scout with a cavalry unit to find the enemy base ("enemy_base" works once a structure of theirs has been seen).
- Attack with a large group (15 or more soldiers), not piecemeal; keep training reinforcements and set the rally point of your barracks forward. Retreat badly hurt groups and garrison citizens in the civic centre when attacked.
- A refused order tells you why and what is available; do not repeat an order that was refused for the same reason.

Each turn you get your situation as JSON ("Your situation now") and the results of your last orders. Give all your orders for the turn in one reply, as several tool calls. Do not explain yourself.`;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const UNITS = '"idle", "idle_workers", "idle_military", "military" (all soldiers), "infantry", "cavalry", "siege", "champion", "workers", "all", a cell such as "D4", or a comma-separated list of entity ids';

export const TOOLS = [
  tool("gather", "Send workers to gather a resource from the nearest known source.", {
    resource: { type: "string", enum: ["food", "wood", "stone", "metal"] },
    workers: { type: "integer", minimum: 1, description: "How many workers (default: the idle ones, else about half of those on other resources)" },
  }, ["resource"]),
  tool("train", "Train units at a building that can train them (a batch).", {
    unit: { type: "string", description: 'A unit name from your view\'s options.train, e.g. "support_civilian", "infantry_spearman", "cavalry_javelineer"' },
    count: { type: "integer", minimum: 1, maximum: 20 },
    building: { type: "string", description: 'Optional: "civil_centre", "barracks", "stable" or a building id' },
  }, ["unit", "count"]),
  tool("build", "Build a structure near a place with up to four workers.", {
    structure: { type: "string", description: 'A name from your view\'s options.build, e.g. "house", "storehouse", "farmstead", "field", "barracks", "stable", "outpost", "defense_tower", "temple", "market"' },
    near: { type: "string", description: 'Where: "cc" (default), a cell such as "C4", or an entity id (e.g. a resource to put a storehouse next to)' },
  }, ["structure"]),
  tool("research", "Research a technology at a building that offers it.", {
    tech: { type: "string", description: "A technology name from your view's options.research" },
  }, ["tech"]),
  tool("phase_up", "Advance to the next phase (town, then city) when the requirements are met.", {}),
  tool("attack", "Attack-move units towards a target; they fight whatever they meet on the way.", {
    target: { type: "string", description: '"enemy_base" (the nearest known enemy civic centre or structure), "nearest_enemy", a cell such as "H9", or an enemy entity id' },
    units: { type: "string", description: `Which units (default "military"): ${UNITS}` },
  }, ["target"]),
  tool("move", "Move units to a place without attacking on the way (scouting, regrouping).", {
    units: { type: "string", description: UNITS },
    to: { type: "string", description: 'A cell such as "F6", "cc", or an entity id' },
  }, ["units", "to"]),
  tool("retreat", "Send units back to the civic centre.", {
    units: { type: "string", description: `Which units (default "military"): ${UNITS}` },
  }),
  tool("garrison", "Garrison units inside a building (the civic centre by default) to protect them; the building shoots more arrows.", {
    units: { type: "string", description: `Which units (default "workers"): ${UNITS}` },
    building: { type: "string", description: 'A building name such as "civil_centre", "defense_tower" or an id' },
  }),
  tool("set_rallypoint", "Set where newly trained units go.", {
    building: { type: "string", description: 'A building name such as "barracks" or "civil_centre" (default), or an id' },
    at: { type: "string", description: 'A cell such as "E5", "cc", or an entity id' },
  }, ["at"]),
  tool("stance", "Set the stance of units.", {
    units: { type: "string", description: UNITS },
    stance: { type: "string", enum: ["violent", "aggressive", "defensive", "passive", "standground"] },
  }, ["units", "stance"]),
];

export const TOOL_NAMES = TOOLS.map((t) => t.function.name);
