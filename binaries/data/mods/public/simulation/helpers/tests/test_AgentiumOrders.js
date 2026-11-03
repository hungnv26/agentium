Engine.LoadHelperScript("Player.js");
Engine.LoadHelperScript("AgentiumView.js");
Engine.LoadHelperScript("AgentiumOrders.js");
Engine.LoadComponentScript("interfaces/Builder.js");
Engine.LoadComponentScript("interfaces/Diplomacy.js");
Engine.LoadComponentScript("interfaces/Foundation.js");
Engine.LoadComponentScript("interfaces/Health.js");
Engine.LoadComponentScript("interfaces/Player.js");
Engine.LoadComponentScript("interfaces/PlayerManager.js");
Engine.LoadComponentScript("interfaces/ProductionQueue.js");
Engine.LoadComponentScript("interfaces/ResourceGatherer.js");
Engine.LoadComponentScript("interfaces/ResourceSupply.js");
Engine.LoadComponentScript("interfaces/Researcher.js");
Engine.LoadComponentScript("interfaces/TechnologyManager.js");
Engine.LoadComponentScript("interfaces/Trainer.js");
Engine.LoadComponentScript("interfaces/UnitAI.js");

// Grid helpers: 1200-unit map, 12 cells of 100 units.
const mapSize = 1200;
AddMock(SYSTEM_ENTITY, IID_Terrain, { "GetMapSize": () => mapSize });

TS_ASSERT_EQUALS(AgentiumCell(0, 0, mapSize), "A1");
TS_ASSERT_EQUALS(AgentiumCell(250, 1150, mapSize), "C12");
TS_ASSERT_EQUALS(AgentiumCell(1199, 1199, mapSize), "L12");
TS_ASSERT_EQUALS(AgentiumCell(-5, 5000, mapSize), "A12");
TS_ASSERT_UNEVAL_EQUALS(AgentiumCellCenter("C4", mapSize), { "x": 250, "z": 350 });
TS_ASSERT_UNEVAL_EQUALS(AgentiumCellCenter(" l12 ", mapSize), { "x": 1150, "z": 1150 });
TS_ASSERT_EQUALS(AgentiumCellCenter("M1", mapSize), undefined);
TS_ASSERT_EQUALS(AgentiumCellCenter("C13", mapSize), undefined);
TS_ASSERT_EQUALS(AgentiumCellCenter(42, mapSize), undefined);
const back = AgentiumCellCenter("G7", mapSize);
TS_ASSERT_EQUALS(AgentiumCell(back.x, back.z, mapSize), "G7");

// Names.
TS_ASSERT_EQUALS(AgentiumShortName("units/spart/infantry_spearman_b"), "infantry_spearman_b");
TS_ASSERT_EQUALS(AgentiumShortName("structures/spart/house"), "house");
TS_ASSERT_EQUALS(AgentiumShortName("gaia/tree/oak"), "tree/oak");
TS_ASSERT_EQUALS(AgentiumShortName(""), "");
TS_ASSERT(AgentiumNameMatches("infantry_spearman", "units/spart/infantry_spearman_b"));
TS_ASSERT(AgentiumNameMatches("Infantry_Spearman_b", "units/spart/infantry_spearman_b"));
TS_ASSERT(AgentiumNameMatches("house", "structures/spart/house"));
TS_ASSERT(!AgentiumNameMatches("house", "structures/spart/storehouse"));
TS_ASSERT(!AgentiumNameMatches("cavalry", "units/spart/infantry_spearman_b"));
TS_ASSERT(AgentiumNameMatches("cavalry", "units/spart/cavalry_javelineer_b"));

// A tiny world: player 1 with a civic centre (id 20) and a barracks (id 21).
const playerID = 1;
const playerEnt = 10;
const cc = 20;
const barracks = 21;
const resources = { "food": 300, "wood": 300, "stone": 300, "metal": 300 };

AddMock(SYSTEM_ENTITY, IID_PlayerManager, { "GetPlayerByID": id => id == playerID ? playerEnt : INVALID_ENTITY, "GetNumPlayers": () => 2 });
AddMock(playerEnt, IID_Player, {
	"GetPlayerID": () => playerID,
	"GetState": () => "active",
	"GetResourceCounts": () => resources
});
AddMock(playerEnt, IID_TechnologyManager, { "CanProduce": () => true, "CanResearch": () => true, "GetQueuedResearch": () => ({}) });
AddMock(SYSTEM_ENTITY, IID_RangeManager, {
	"GetEntitiesByPlayer": id => id == playerID ? [cc, barracks] : [],
	"GetNonGaiaEntities": () => [cc, barracks],
	"GetLosVisibility": () => "visible"
});
const templateNames = { [cc]: "structures/spart/civil_centre", [barracks]: "structures/spart/barracks" };
AddMock(SYSTEM_ENTITY, IID_TemplateManager, {
	"GetCurrentTemplateName": ent => templateNames[ent],
	"TemplateExists": () => true,
	"GetTemplate": name => ({ "Cost": { "Resources": { "food": name.indexOf("cavalry") != -1 ? "100" : "50", "wood": name.indexOf("cavalry") != -1 ? "40" : "0" }, "Population": "1" } })
});
for (const ent of [cc, barracks])
{
	AddMock(ent, IID_Identity, { "HasClass": cls => cls == "Structure" || (ent == cc && cls == "CivilCentre") });
	AddMock(ent, IID_Position, { "IsInWorld": () => true, "GetPosition2D": () => new Vector2D(ent == cc ? 500 : 560, 500) });
}
AddMock(cc, IID_Trainer, { "GetEntitiesList": () => ["units/spart/support_female_citizen", "units/spart/infantry_spearman_b"] });
AddMock(cc, IID_ProductionQueue, { "GetQueue": () => [{ "unitTemplate": "units/spart/support_female_citizen", "count": 2, "progress": 0.5 }] });
AddMock(barracks, IID_Trainer, { "GetEntitiesList": () => ["units/spart/infantry_spearman_b", "units/spart/cavalry_javelineer_b"] });
AddMock(barracks, IID_ProductionQueue, { "GetQueue": () => [] });

// Cost: 50 food each.
TS_ASSERT_UNEVAL_EQUALS(AgentiumTemplateCost("units/spart/infantry_spearman_b"), { "food": 50, "pop": 1 });

// train picks the building with the shortest queue that can train the unit.
let result = AgentiumResolve(playerID, { "order": "train", "unit": "infantry_spearman", "count": 3 });
TS_ASSERT(result.ok);
TS_ASSERT_EQUALS(result.commands.length, 1);
TS_ASSERT_UNEVAL_EQUALS(result.commands[0], { "type": "train", "entities": [barracks], "template": "units/spart/infantry_spearman_b", "count": 3 });

// Restricting to a building by name.
result = AgentiumResolve(playerID, { "order": "train", "unit": "infantry_spearman", "building": "civil_centre" });
TS_ASSERT(result.ok);
TS_ASSERT_EQUALS(result.commands[0].entities[0], cc);
TS_ASSERT_EQUALS(result.commands[0].count, 1);

// Orders also arrive as JSON strings.
result = AgentiumResolve(playerID, JSON.stringify({ "order": "train", "unit": "cavalry_javelineer", "count": 2 }));
TS_ASSERT(result.ok);
TS_ASSERT_EQUALS(result.commands[0].template, "units/spart/cavalry_javelineer_b");

// Unaffordable: 10 cavalry need 1000 food.
result = AgentiumResolve(playerID, { "order": "train", "unit": "cavalry_javelineer", "count": 10 });
TS_ASSERT(!result.ok);
TS_ASSERT(result.message.indexOf("needs 1000 food") != -1);

// Unknown unit: the refusal lists what is trainable.
result = AgentiumResolve(playerID, { "order": "train", "unit": "elephant" });
TS_ASSERT(!result.ok);
TS_ASSERT(result.message.indexOf("cavalry_javelineer_b") != -1);

// Unknown order and bad input.
result = AgentiumResolve(playerID, { "order": "dance" });
TS_ASSERT(!result.ok);
TS_ASSERT(result.message.indexOf("train") != -1);
TS_ASSERT(!AgentiumResolve(playerID, "{not json").ok);
TS_ASSERT(!AgentiumResolve(playerID, 42).ok);
TS_ASSERT(!AgentiumResolve(7, { "order": "train", "unit": "x" }).ok);

// Locations.
TS_ASSERT_UNEVAL_EQUALS(AgentiumResolveLocation(playerID, "cc"), { "x": 500, "z": 500 });
TS_ASSERT_UNEVAL_EQUALS(AgentiumResolveLocation(playerID, "B2"), { "x": 150, "z": 150 });
TS_ASSERT_UNEVAL_EQUALS(AgentiumResolveLocation(playerID, barracks), { "x": 560, "z": 500 });
TS_ASSERT_EQUALS(AgentiumResolveLocation(playerID, "nowhere"), undefined);

// A rally point on the civic centre.
AddMock(cc, IID_RallyPoint, {});
result = AgentiumResolve(playerID, { "order": "set_rallypoint", "building": "civil_centre", "at": "B2" });
TS_ASSERT(result.ok);
TS_ASSERT_UNEVAL_EQUALS(result.commands[0], { "type": "set-rallypoint", "entities": [cc], "x": 150, "z": 150, "data": { "command": "walk" }, "queued": false });

// No soldiers yet: attack is refused with advice.
result = AgentiumResolve(playerID, { "order": "attack", "target": "enemy_base" });
TS_ASSERT(!result.ok);
TS_ASSERT(result.message.indexOf("train soldiers") != -1);
