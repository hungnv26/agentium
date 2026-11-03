/**
 * Agentium: turn high-level orders from an AI model (or the advisor) into the
 * command payloads handled by simulation/helpers/Commands.js.
 *
 * AgentiumResolve(player, order) never changes the simulation; it returns
 *   { "ok": true, "message": "...", "commands": [ {command}, ... ] }
 * or
 *   { "ok": false, "message": "why, and what is available instead" }
 * The caller posts the commands through the turn manager (RL /step or
 * Engine.PostNetworkCommand) so they are recorded in the replay like any
 * player command.
 *
 * Orders (all names are short template names, cells are "C4"):
 *   { order: "gather", resource, workers? }
 *   { order: "train", unit, count?, building? }
 *   { order: "build", structure, near? }         near: cell | "cc" | entity id
 *   { order: "research", tech }
 *   { order: "attack", target, units? }           target: cell | entity id | "enemy_base" | "nearest_enemy"
 *   { order: "move", units, to }
 *   { order: "retreat", units? }
 *   { order: "garrison", units?, building? }
 *   { order: "set_rallypoint", building, at }
 *   { order: "stance", units, stance }
 *   { order: "phase_up" }
 * Unit selectors: "idle" | "military" | "infantry" | "cavalry" | "siege" | "champion" |
 *   "workers" | "all" | a cell | an entity id | an array of entity ids.
 */

var AGENTIUM_BUILD_SEARCH_STEP = 10;
var AGENTIUM_BUILD_SEARCH_RADIUS = 90;

function AgentiumFail(message)
{
	return { "ok": false, "message": message };
}

function AgentiumOk(message, commands)
{
	return { "ok": true, "message": message, "commands": commands };
}

function AgentiumIsWorker(ent)
{
	const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
	return !!Engine.QueryInterface(ent, IID_Builder) ||
		(cmpIdentity && cmpIdentity.HasClass("Support") && !!Engine.QueryInterface(ent, IID_ResourceGatherer));
}

function AgentiumIsMilitary(ent)
{
	const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
	const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
	if (!cmpIdentity || !cmpUnitAI || cmpUnitAI.IsAnimal() || cmpUnitAI.IsFormationController())
		return false;
	if (!Engine.QueryInterface(ent, IID_Attack))
		return false;
	return !cmpIdentity.HasClass("Support") && !cmpIdentity.HasClass("Trader") && !cmpIdentity.HasClass("Ship") ||
		cmpIdentity.HasClass("Warship");
}

function AgentiumIsGarrisoned(ent)
{
	const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
	return cmpUnitAI && cmpUnitAI.GetCurrentState().indexOf("GARRISON") != -1;
}

/**
 * Resolve a unit selector to a list of the player's unit entities.
 */
function AgentiumSelectUnits(player, selector, own, defaultSelector)
{
	if (selector === undefined || selector === null || selector === "")
		selector = defaultSelector;
	const mapSize = AgentiumMapSize();
	if (Array.isArray(selector))
		return own.units.filter(ent => selector.indexOf(ent) != -1);
	if (typeof selector == "number")
		return own.units.filter(ent => ent == selector);
	const s = String(selector).toLowerCase().trim();
	// own.units holds no animals (livestock is never ordered around).
	const alive = own.units.filter(ent => AgentiumPosition(ent) && !AgentiumIsGarrisoned(ent));
	if (/^\d+$/.test(s))
		return alive.filter(ent => ent == +s);
	if (AgentiumCellCenter(s, mapSize))
		return alive.filter(ent => {
			const pos = AgentiumPosition(ent);
			return AgentiumCell(pos.x, pos.z, mapSize).toLowerCase() == s;
		});
	switch (s)
	{
	case "all":
		return alive;
	case "idle":
		return alive.filter(ent => {
			const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
			return cmpUnitAI && cmpUnitAI.IsIdle();
		});
	case "military":
	case "all_military":
	case "army":
		return alive.filter(AgentiumIsMilitary);
	case "idle_military":
		return alive.filter(ent => AgentiumIsMilitary(ent) && Engine.QueryInterface(ent, IID_UnitAI).IsIdle());
	case "workers":
	case "citizens":
	case "gatherers":
		return alive.filter(AgentiumIsWorker);
	case "idle_workers":
		return alive.filter(ent => AgentiumIsWorker(ent) && Engine.QueryInterface(ent, IID_UnitAI).IsIdle());
	default:
	{
		// A class name (Infantry, Cavalry, Siege, Champion, Hero, Ranged, Melee, ...) or a template short name.
		const cls = s.charAt(0).toUpperCase() + s.slice(1);
		const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
		return alive.filter(ent => {
			const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
			if (cmpIdentity && cmpIdentity.HasClass(cls) && AgentiumIsMilitary(ent))
				return true;
			return AgentiumNameMatches(s, cmpTemplateManager.GetCurrentTemplateName(ent));
		});
	}
	}
}

/**
 * Resolve a location: cell, "cc", entity id, or {x, z}.
 */
function AgentiumResolveLocation(player, where)
{
	if (where && typeof where == "object" && where.x !== undefined && where.z !== undefined)
		return { "x": +where.x, "z": +where.z };
	if (typeof where == "number" || (typeof where == "string" && /^\d+$/.test(where.trim())))
		return AgentiumPosition(+where);
	if (typeof where == "string")
	{
		const s = where.trim().toLowerCase();
		if (s == "cc" || s == "base" || s == "home")
		{
			const cc = AgentiumCivicCentre(player);
			return cc ? AgentiumPosition(cc) : undefined;
		}
		return AgentiumCellCenter(s);
	}
	return undefined;
}

function AgentiumCentroid(entities)
{
	let x = 0, z = 0, n = 0;
	for (const ent of entities)
	{
		const pos = AgentiumPosition(ent);
		if (!pos)
			continue;
		x += pos.x; z += pos.z; ++n;
	}
	return n ? { "x": x / n, "z": z / n } : undefined;
}

function AgentiumSortByDistance(entities, origin)
{
	if (!origin)
		return entities;
	return entities
		.map(ent => ({ "ent": ent, "d": AgentiumDistance(origin, AgentiumPosition(ent) || origin) }))
		.sort((a, b) => a.d - b.d)
		.map(item => item.ent);
}

function AgentiumListNames(templateNames, max = 12)
{
	const names = Array.from(new Set(templateNames.map(AgentiumShortName)));
	return names.slice(0, max).join(", ") + (names.length > max ? ", ..." : "");
}

// ---------------------------------------------------------------- gather

function AgentiumOrderGather(player, order, own)
{
	const resource = String(order.resource || "").toLowerCase().trim();
	if (["food", "wood", "stone", "metal"].indexOf(resource) == -1)
		return AgentiumFail("gather: resource must be one of food, wood, stone, metal");

	let workers = AgentiumSelectUnits(player, order.units, own, "workers")
		.filter(ent => Engine.QueryInterface(ent, IID_ResourceGatherer));
	if (!workers.length)
		return AgentiumFail("gather: you have no units that can gather");

	// Prefer idle workers, then those gathering something else.
	const idle = workers.filter(ent => Engine.QueryInterface(ent, IID_UnitAI).IsIdle());
	const other = workers.filter(ent => {
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		if (cmpUnitAI.IsIdle())
			return false;
		const cmpGatherer = Engine.QueryInterface(ent, IID_ResourceGatherer);
		const type = cmpGatherer.GetMainCarryingType() || cmpGatherer.GetLastCarriedType();
		return !type || type.generic != resource;
	});
	const wanted = Math.max(1, Math.min(workers.length, +order.workers || (idle.length || Math.ceil(other.length / 2))));
	workers = idle.concat(other).slice(0, wanted);
	if (!workers.length)
		return AgentiumFail("gather: all workers already gather " + resource);

	const origin = AgentiumCentroid(workers) || AgentiumPosition(AgentiumCivicCentre(player));
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	let best, bestDist = Infinity;
	for (const ent of cmpRangeManager.GetEntitiesByPlayer(0))
	{
		const cmpSupply = Engine.QueryInterface(ent, IID_ResourceSupply);
		if (!cmpSupply || cmpSupply.GetType().generic != resource)
			continue;
		if (cmpSupply.GetCurrentAmount() <= 0 || cmpSupply.GetNumGatherers() >= cmpSupply.GetMaxGatherers())
			continue;
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (cmpIdentity && cmpIdentity.HasClass("Animal") && !cmpIdentity.HasClass("Domestic"))
		{
			const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
			if (cmpUnitAI && !cmpUnitAI.IsAnimal())
				continue;
		}
		const pos = AgentiumPosition(ent);
		if (!pos || cmpRangeManager.GetLosVisibility(ent, player) == "hidden")
			continue;
		const d = origin ? AgentiumDistance(origin, pos) : 0;
		if (d < bestDist)
		{
			best = ent;
			bestDist = d;
		}
	}
	if (!best)
		return AgentiumFail("gather: no known " + resource + " source with free gathering slots; explore or build a farm");

	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const name = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(best));
	const pos = AgentiumPosition(best);
	return AgentiumOk(workers.length + " workers sent to gather " + resource + " from " + name + " at " + AgentiumCell(pos.x, pos.z),
		[{ "type": "gather", "entities": workers, "target": best, "queued": false }]);
}

// ---------------------------------------------------------------- train

function AgentiumOrderTrain(player, order, own)
{
	const count = Math.max(1, Math.min(20, Math.floor(+order.count || 1)));
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);
	const candidates = [];
	const everything = [];
	for (const ent of own.structures)
	{
		if (Engine.QueryInterface(ent, IID_Foundation))
			continue;
		const cmpTrainer = Engine.QueryInterface(ent, IID_Trainer);
		if (!cmpTrainer)
			continue;
		if (order.building !== undefined && order.building !== null && order.building !== "")
		{
			const b = String(order.building);
			if (/^\d+$/.test(b) ? ent != +b : !AgentiumNameMatches(b, cmpTemplateManager.GetCurrentTemplateName(ent)))
				continue;
		}
		for (const templateName of cmpTrainer.GetEntitiesList())
		{
			if (cmpTechnologyManager && !cmpTechnologyManager.CanProduce(templateName))
				continue;
			everything.push(templateName);
			if (AgentiumNameMatches(order.unit, templateName))
			{
				const cmpQueue = Engine.QueryInterface(ent, IID_ProductionQueue);
				candidates.push({ "ent": ent, "template": templateName, "queue": cmpQueue ? cmpQueue.GetQueue().length : 99 });
			}
		}
	}
	if (!candidates.length)
		return AgentiumFail("train: none of your buildings can train \"" + order.unit + "\" now; trainable: " + AgentiumListNames(everything));

	candidates.sort((a, b) => a.queue - b.queue);
	const pick = candidates[0];
	const cost = AgentiumTemplateCost(pick.template);
	const cmpPlayer = QueryPlayerIDInterface(player, IID_Player);
	const have = cmpPlayer.GetResourceCounts();
	for (const res in cost)
		if (res != "pop" && have[res] < cost[res] * count)
			return AgentiumFail("train: " + count + "x " + AgentiumShortName(pick.template) + " needs " + cost[res] * count + " " + res + ", you have " + Math.floor(have[res]));
	const where = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(pick.ent));
	return AgentiumOk("training " + count + "x " + AgentiumShortName(pick.template) + " at " + where + " (" + pick.ent + ")",
		[{ "type": "train", "entities": [pick.ent], "template": pick.template, "count": count }]);
}

// ---------------------------------------------------------------- build

function AgentiumFindBuildSite(player, templateName, anchor)
{
	const cmpGuiInterface = Engine.QueryInterface(SYSTEM_ENTITY, IID_GuiInterface);
	const mapSize = AgentiumMapSize();
	let found;
	let lastMessage = "";
	// Spiral outwards from the anchor; the first valid placement wins.
	const probe = (x, z, angle) => {
		if (x < 0 || z < 0 || x > mapSize || z > mapSize)
			return false;
		const result = cmpGuiInterface.SetBuildingPlacementPreview(player, { "template": templateName, "x": x, "z": z, "angle": angle });
		if (result.success)
			found = { "x": x, "z": z, "angle": angle };
		else if (result.message)
			lastMessage = result.message;
		return result.success;
	};
	try
	{
		const angle = Math.PI * 0.75;
		outer:
		for (let r = 0; r <= AGENTIUM_BUILD_SEARCH_RADIUS; r += AGENTIUM_BUILD_SEARCH_STEP)
		{
			const steps = r == 0 ? 1 : Math.max(8, Math.round(2 * Math.PI * r / AGENTIUM_BUILD_SEARCH_STEP));
			for (let i = 0; i < steps; ++i)
			{
				const a = 2 * Math.PI * i / steps;
				if (probe(anchor.x + r * Math.cos(a), anchor.z + r * Math.sin(a), angle))
					break outer;
			}
		}
	}
	finally
	{
		// Always destroy the local preview entity.
		cmpGuiInterface.SetBuildingPlacementPreview(player, { "template": "" });
	}
	return found || { "error": lastMessage || "no valid site found" };
}

function AgentiumOrderBuild(player, order, own)
{
	const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);
	const builders = own.units.filter(ent => Engine.QueryInterface(ent, IID_Builder) && AgentiumPosition(ent) && !AgentiumIsGarrisoned(ent));
	if (!builders.length)
		return AgentiumFail("build: you have no units that can build");

	const all = new Set();
	let templateName;
	for (const ent of builders)
	{
		for (const name of Engine.QueryInterface(ent, IID_Builder).GetEntitiesList())
		{
			if (cmpTechnologyManager && !cmpTechnologyManager.CanProduce(name))
				continue;
			all.add(name);
			if (!templateName && AgentiumNameMatches(order.structure, name))
				templateName = name;
		}
		if (templateName)
			break;
	}
	if (!templateName)
		return AgentiumFail("build: \"" + order.structure + "\" is not something you can build now; buildable: " + AgentiumListNames(Array.from(all)));

	const cost = AgentiumTemplateCost(templateName);
	const have = QueryPlayerIDInterface(player, IID_Player).GetResourceCounts();
	for (const res in cost)
		if (res != "pop" && have[res] < cost[res])
			return AgentiumFail("build: " + AgentiumShortName(templateName) + " needs " + cost[res] + " " + res + ", you have " + Math.floor(have[res]));

	const anchor = AgentiumResolveLocation(player, order.near === undefined ? "cc" : order.near);
	if (!anchor)
		return AgentiumFail("build: \"near\" must be a cell like C4, \"cc\" or an entity id");

	const site = AgentiumFindBuildSite(player, templateName, anchor);
	if (site.error)
		return AgentiumFail("build: no valid site for " + AgentiumShortName(templateName) + " near " + AgentiumCell(anchor.x, anchor.z) + " (" + site.error + "); try another cell inside your territory");

	// Up to 4 builders: idle first, then nearest.
	const idle = builders.filter(ent => Engine.QueryInterface(ent, IID_UnitAI).IsIdle());
	const workers = AgentiumSortByDistance(idle.length >= 2 ? idle : builders, site).slice(0, 4);
	return AgentiumOk("building " + AgentiumShortName(templateName) + " at " + AgentiumCell(site.x, site.z) + " with " + workers.length + " workers", [{
		"type": "construct",
		"entities": workers,
		"template": templateName,
		"x": site.x,
		"z": site.z,
		"angle": site.angle,
		"autorepair": true,
		"autocontinue": true,
		"queued": false
	}]);
}

// ---------------------------------------------------------------- research

function AgentiumResearchable(player, own)
{
	const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);
	const list = [];
	for (const ent of own.structures)
	{
		if (Engine.QueryInterface(ent, IID_Foundation))
			continue;
		const cmpResearcher = Engine.QueryInterface(ent, IID_Researcher);
		if (!cmpResearcher)
			continue;
		for (const item of cmpResearcher.GetTechnologiesList())
		{
			if (!item)
				continue;
			for (const tech of typeof item == "object" ? [item.top, item.bottom] : [item])
				if (tech && (!cmpTechnologyManager || cmpTechnologyManager.CanResearch(tech)))
					list.push({ "ent": ent, "tech": tech });
		}
	}
	return list;
}

function AgentiumResearchCommand(player, pick)
{
	const cost = AgentiumTechCost(pick.tech);
	const have = QueryPlayerIDInterface(player, IID_Player).GetResourceCounts();
	for (const res in cost)
		if (have[res] < cost[res])
			return AgentiumFail("research: " + pick.tech + " needs " + cost[res] + " " + res + ", you have " + Math.floor(have[res]));
	return AgentiumOk("researching " + pick.tech + " at " + pick.ent, [{ "type": "research", "entity": pick.ent, "template": pick.tech }]);
}

function AgentiumOrderResearch(player, order, own)
{
	const wanted = String(order.tech || "").toLowerCase().trim();
	const list = AgentiumResearchable(player, own);
	const pick = list.find(item => item.tech.toLowerCase() == wanted) ||
		list.find(item => item.tech.toLowerCase().indexOf(wanted) != -1);
	if (!pick)
		return AgentiumFail("research: \"" + order.tech + "\" is not researchable now; available: " +
			Array.from(new Set(list.map(item => item.tech))).slice(0, 12).join(", "));
	return AgentiumResearchCommand(player, pick);
}

function AgentiumOrderPhaseUp(player, order, own)
{
	const list = AgentiumResearchable(player, own);
	const pick = list.find(item => item.tech.startsWith("phase_town")) || list.find(item => item.tech.startsWith("phase_city"));
	if (!pick)
	{
		const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);
		const queued = cmpTechnologyManager ? Object.keys(cmpTechnologyManager.GetQueuedResearch()).filter(t => t.startsWith("phase_")) : [];
		if (queued.length)
			return AgentiumFail("phase_up: " + queued[0] + " is already being researched");
		return AgentiumFail("phase_up: no phase advance available now (already at the last phase, or requirements such as the number of structures are not met)");
	}
	return AgentiumResearchCommand(player, pick);
}

// ---------------------------------------------------------------- military

function AgentiumKnownEnemies(player, filter)
{
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	const cmpDiplomacy = QueryPlayerIDInterface(player, IID_Diplomacy);
	const list = [];
	for (const ent of cmpRangeManager.GetNonGaiaEntities())
	{
		const cmpOwnership = Engine.QueryInterface(ent, IID_Ownership);
		if (!cmpOwnership)
			continue;
		const owner = cmpOwnership.GetOwner();
		if (owner == player || owner <= 0 || (cmpDiplomacy && !cmpDiplomacy.IsEnemy(owner)))
			continue;
		const visibility = cmpRangeManager.GetLosVisibility(ent, player);
		if (visibility == "hidden")
			continue;
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (!cmpIdentity || !AgentiumPosition(ent))
			continue;
		if (filter(cmpIdentity, visibility))
			list.push(ent);
	}
	return list;
}

function AgentiumResolveTarget(player, target, units)
{
	const origin = AgentiumCentroid(units) || AgentiumPosition(AgentiumCivicCentre(player));
	if (typeof target == "string")
	{
		const s = target.trim().toLowerCase();
		if (s == "enemy_base" || s == "enemy_cc" || s == "enemy")
		{
			const ccs = AgentiumKnownEnemies(player, id => id.HasClass("CivilCentre"));
			const structures = ccs.length ? ccs : AgentiumKnownEnemies(player, id => id.HasClass("Structure"));
			if (!structures.length)
				return { "error": "no enemy structure is known yet; scout first (move units towards the far side of the map)" };
			const pos = AgentiumPosition(AgentiumSortByDistance(structures, origin)[0]);
			return { "x": pos.x, "z": pos.z, "label": "enemy " + (ccs.length ? "civic centre" : "structure") + " at " + AgentiumCell(pos.x, pos.z) };
		}
		if (s == "nearest_enemy" || s == "nearest")
		{
			const enemies = AgentiumKnownEnemies(player, (id, vis) => vis == "visible" && id.HasClass("Unit") || id.HasClass("Structure"));
			if (!enemies.length)
				return { "error": "no enemy is visible" };
			const pos = AgentiumPosition(AgentiumSortByDistance(enemies, origin)[0]);
			return { "x": pos.x, "z": pos.z, "label": "nearest enemy at " + AgentiumCell(pos.x, pos.z) };
		}
	}
	const pos = AgentiumResolveLocation(player, target);
	if (!pos)
		return { "error": "target must be a cell like C4, an entity id, \"enemy_base\" or \"nearest_enemy\"" };
	return { "x": pos.x, "z": pos.z, "label": AgentiumCell(pos.x, pos.z) };
}

function AgentiumOrderAttack(player, order, own)
{
	const units = AgentiumSelectUnits(player, order.units, own, "military").filter(AgentiumIsMilitary);
	if (!units.length)
		return AgentiumFail("attack: no military units match \"" + (order.units || "military") + "\"; train soldiers first");
	const target = AgentiumResolveTarget(player, order.target === undefined ? "enemy_base" : order.target, units);
	if (target.error)
		return AgentiumFail("attack: " + target.error);
	return AgentiumOk(units.length + " units attack-move to " + target.label, [{
		"type": "attack-walk",
		"entities": units,
		"x": target.x,
		"z": target.z,
		"targetClasses": { "attack": ["Unit", "Structure"] },
		"allowCapture": false,
		"queued": false
	}]);
}

function AgentiumOrderMove(player, order, own)
{
	const units = AgentiumSelectUnits(player, order.units, own, "idle_military");
	if (!units.length)
		return AgentiumFail("move: no units match \"" + (order.units || "idle_military") + "\"");
	const pos = AgentiumResolveLocation(player, order.to);
	if (!pos)
		return AgentiumFail("move: \"to\" must be a cell like C4, \"cc\" or an entity id");
	return AgentiumOk(units.length + " units move to " + AgentiumCell(pos.x, pos.z),
		[{ "type": "walk", "entities": units, "x": pos.x, "z": pos.z, "queued": false }]);
}

function AgentiumOrderRetreat(player, order, own)
{
	const units = AgentiumSelectUnits(player, order.units, own, "military");
	if (!units.length)
		return AgentiumFail("retreat: no units match \"" + (order.units || "military") + "\"");
	const cc = AgentiumCivicCentre(player);
	const pos = cc && AgentiumPosition(cc);
	if (!pos)
		return AgentiumFail("retreat: you have no civic centre to retreat to");
	return AgentiumOk(units.length + " units retreat to " + AgentiumCell(pos.x, pos.z),
		[{ "type": "walk", "entities": units, "x": pos.x, "z": pos.z, "queued": false }]);
}

function AgentiumOrderGarrison(player, order, own)
{
	let building;
	if (order.building !== undefined && order.building !== null && order.building !== "")
	{
		const b = String(order.building);
		const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
		building = own.structures.find(ent => Engine.QueryInterface(ent, IID_GarrisonHolder) &&
			(/^\d+$/.test(b) ? ent == +b : AgentiumNameMatches(b, cmpTemplateManager.GetCurrentTemplateName(ent))));
	}
	else
		building = AgentiumCivicCentre(player);
	if (!building || !Engine.QueryInterface(building, IID_GarrisonHolder))
		return AgentiumFail("garrison: no garrisonable building matches \"" + order.building + "\"");
	const pos = AgentiumPosition(building);
	const units = AgentiumSortByDistance(AgentiumSelectUnits(player, order.units, own, "workers"), pos).slice(0, 20);
	if (!units.length)
		return AgentiumFail("garrison: no units match \"" + (order.units || "workers") + "\"");
	return AgentiumOk(units.length + " units garrison into " + building,
		[{ "type": "garrison", "entities": units, "target": building, "queued": false }]);
}

function AgentiumOrderRallypoint(player, order, own)
{
	const b = order.building === undefined || order.building === null || order.building === "" ? "civil_centre" : String(order.building);
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const buildings = own.structures.filter(ent => Engine.QueryInterface(ent, IID_RallyPoint) &&
		(/^\d+$/.test(b) ? ent == +b : AgentiumNameMatches(b, cmpTemplateManager.GetCurrentTemplateName(ent))));
	if (!buildings.length)
		return AgentiumFail("set_rallypoint: no building with a rally point matches \"" + b + "\"");
	const pos = AgentiumResolveLocation(player, order.at);
	if (!pos)
		return AgentiumFail("set_rallypoint: \"at\" must be a cell like C4 or an entity id");
	return AgentiumOk("rally point of " + buildings.length + " building(s) set to " + AgentiumCell(pos.x, pos.z),
		[{ "type": "set-rallypoint", "entities": buildings, "x": pos.x, "z": pos.z, "data": { "command": "walk" }, "queued": false }]);
}

function AgentiumOrderStance(player, order, own)
{
	const stance = String(order.stance || "").toLowerCase().trim();
	if (["violent", "aggressive", "defensive", "passive", "standground"].indexOf(stance) == -1)
		return AgentiumFail("stance: must be one of violent, aggressive, defensive, passive, standground");
	const units = AgentiumSelectUnits(player, order.units, own, "military");
	if (!units.length)
		return AgentiumFail("stance: no units match \"" + (order.units || "military") + "\"");
	return AgentiumOk(units.length + " units set to " + stance, [{ "type": "stance", "entities": units, "name": stance }]);
}

// ---------------------------------------------------------------- entry point

var AGENTIUM_ORDERS = {
	"gather": AgentiumOrderGather,
	"train": AgentiumOrderTrain,
	"build": AgentiumOrderBuild,
	"research": AgentiumOrderResearch,
	"phase_up": AgentiumOrderPhaseUp,
	"attack": AgentiumOrderAttack,
	"move": AgentiumOrderMove,
	"retreat": AgentiumOrderRetreat,
	"garrison": AgentiumOrderGarrison,
	"set_rallypoint": AgentiumOrderRallypoint,
	"stance": AgentiumOrderStance
};

/**
 * @param player the player id giving the order.
 * @param order an order object (see the file comment), or a JSON string of one.
 */
function AgentiumResolve(player, order)
{
	if (typeof order == "string")
	{
		try
		{
			order = JSON.parse(order);
		}
		catch (e)
		{
			return AgentiumFail("order is not valid JSON");
		}
	}
	if (!order || typeof order != "object")
		return AgentiumFail("order must be an object like {\"order\":\"train\",\"unit\":\"infantry_spearman\",\"count\":5}");
	const name = String(order.order || order.tool || order.type || "").toLowerCase().trim();
	const handler = AGENTIUM_ORDERS[name];
	if (!handler)
		return AgentiumFail("unknown order \"" + name + "\"; orders: " + Object.keys(AGENTIUM_ORDERS).join(", "));
	const cmpPlayer = QueryPlayerIDInterface(player, IID_Player);
	if (!cmpPlayer)
		return AgentiumFail("no such player " + player);
	if (cmpPlayer.GetState() != "active")
		return AgentiumFail("player " + player + " is " + cmpPlayer.GetState());
	const own = AgentiumOwnEntities(player);
	try
	{
		return handler(player, order, own);
	}
	catch (e)
	{
		return AgentiumFail(name + ": internal error: " + e);
	}
}

Engine.RegisterGlobal("AGENTIUM_ORDERS", AGENTIUM_ORDERS);
Engine.RegisterGlobal("AgentiumSelectUnits", AgentiumSelectUnits);
Engine.RegisterGlobal("AgentiumResolveLocation", AgentiumResolveLocation);
Engine.RegisterGlobal("AgentiumFindBuildSite", AgentiumFindBuildSite);
Engine.RegisterGlobal("AgentiumResolve", AgentiumResolve);
