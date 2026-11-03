/**
 * Agentium: compact, fog-of-war-aware description of a player's situation for
 * AI model players and the in-game advisor.
 *
 * Everything here is read-only with respect to the simulation state, so it may
 * be called from the RL interface's /evaluate, from triggers or from the GUI
 * (through GuiInterface.GetAgentiumView) without affecting replays.
 *
 * Positions are reported as grid cells ("C4"): the map is divided into
 * AGENTIUM_GRID x AGENTIUM_GRID cells, lettered along x and numbered along z.
 */

var AGENTIUM_GRID = 12;
var AGENTIUM_MAX_OPTIONS = { "train": 12, "build": 10, "research": 8 };
var AGENTIUM_MAX_GROUPS = 24;

function AgentiumMapSize()
{
	const cmpTerrain = Engine.QueryInterface(SYSTEM_ENTITY, IID_Terrain);
	return cmpTerrain ? cmpTerrain.GetMapSize() : 1024;
}

/**
 * @return the cell name ("C4") for world coordinates.
 */
function AgentiumCell(x, z, mapSize = AgentiumMapSize())
{
	const cellSize = mapSize / AGENTIUM_GRID;
	const col = Math.min(AGENTIUM_GRID - 1, Math.max(0, Math.floor(x / cellSize)));
	const row = Math.min(AGENTIUM_GRID - 1, Math.max(0, Math.floor(z / cellSize)));
	return String.fromCharCode(65 + col) + (row + 1);
}

/**
 * @return {x, z} of the centre of a cell name, or undefined if it is not a cell.
 */
function AgentiumCellCenter(cell, mapSize = AgentiumMapSize())
{
	if (typeof cell != "string")
		return undefined;
	const m = /^([A-Za-z])(\d{1,2})$/.exec(cell.trim());
	if (!m)
		return undefined;
	const col = m[1].toUpperCase().charCodeAt(0) - 65;
	const row = +m[2] - 1;
	if (col < 0 || col >= AGENTIUM_GRID || row < 0 || row >= AGENTIUM_GRID)
		return undefined;
	const cellSize = mapSize / AGENTIUM_GRID;
	return { "x": (col + 0.5) * cellSize, "z": (row + 0.5) * cellSize };
}

/**
 * "units/spart/infantry_spearman_b" -> "infantry_spearman_b",
 * "structures/spart/house" -> "house", "gaia/tree/oak" -> "tree/oak".
 */
function AgentiumShortName(templateName)
{
	if (!templateName)
		return "";
	const parts = templateName.split("/");
	if (parts[0] == "gaia")
		return parts.slice(1).join("/");
	return parts[parts.length - 1];
}

/**
 * Does a user-supplied short name match a template name?
 * Exact short name, or the short name without its rank suffix (_b/_a/_e), or a prefix.
 */
function AgentiumNameMatches(wanted, templateName)
{
	if (!wanted || !templateName)
		return false;
	const w = String(wanted).toLowerCase().trim();
	if (w == templateName)
		return true;
	const short = AgentiumShortName(templateName).toLowerCase();
	if (w == short)
		return true;
	const noRank = short.replace(/_[bae]$/, "");
	return w == noRank || short.startsWith(w + "_") || noRank.startsWith(w + "_");
}

function AgentiumPosition(ent)
{
	const cmpPosition = Engine.QueryInterface(ent, IID_Position);
	if (!cmpPosition || !cmpPosition.IsInWorld())
		return undefined;
	const pos = cmpPosition.GetPosition2D();
	return { "x": pos.x, "z": pos.y };
}

function AgentiumDistance(a, b)
{
	return Math.hypot(a.x - b.x, a.z - b.z);
}

function AgentiumTemplateCost(templateName)
{
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const template = cmpTemplateManager.GetTemplate(templateName);
	const cost = {};
	if (template && template.Cost)
	{
		if (template.Cost.Resources)
			for (const res in template.Cost.Resources)
				if (+template.Cost.Resources[res])
					cost[res] = +template.Cost.Resources[res];
		if (+template.Cost.Population)
			cost.pop = +template.Cost.Population;
	}
	return cost;
}

function AgentiumAffordable(cost, resourceCounts)
{
	for (const res in cost)
		if (res != "pop" && (resourceCounts[res] || 0) < cost[res])
			return false;
	return true;
}

function AgentiumTechCost(techName)
{
	const template = TechnologyTemplates.Get(techName);
	const cost = {};
	if (template && template.cost)
		for (const res in template.cost)
			if (+template.cost[res])
				cost[res] = +template.cost[res];
	return cost;
}

/**
 * One word describing what a unit is doing, derived from its UnitAI state.
 */
function AgentiumActivity(ent, cmpUnitAI)
{
	if (!cmpUnitAI)
		return "static";
	if (cmpUnitAI.IsIdle())
		return "idle";
	const state = cmpUnitAI.GetCurrentState() || "";
	if (state.indexOf("GATHER") != -1 || state.indexOf("RETURNRESOURCE") != -1)
	{
		const cmpGatherer = Engine.QueryInterface(ent, IID_ResourceGatherer);
		const type = cmpGatherer && (cmpGatherer.GetMainCarryingType() || cmpGatherer.GetLastCarriedType());
		return "gathering" + (type && type.generic ? "_" + type.generic : "");
	}
	if (state.indexOf("COMBAT") != -1 || state.indexOf("ATTACK") != -1)
		return "fighting";
	if (state.indexOf("REPAIR") != -1 || state.indexOf("CONSTRUCT") != -1)
		return "building";
	if (state.indexOf("GARRISON") != -1)
		return "garrisoned";
	if (state.indexOf("FLEEING") != -1)
		return "fleeing";
	if (state.indexOf("WALKING") != -1 || state.indexOf("WALK") != -1 || state.indexOf("PATROL") != -1)
		return "moving";
	if (state.indexOf("HEAL") != -1)
		return "healing";
	if (state.indexOf("TRADE") != -1)
		return "trading";
	return "busy";
}

/**
 * Group a list of entities by short template name; returns at most maxGroups groups
 * sorted by count, each with up to three cells and an activity breakdown.
 */
function AgentiumGroupUnits(entities, mapSize, withOwner, maxGroups = AGENTIUM_MAX_GROUPS)
{
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const groups = new Map();
	for (const ent of entities)
	{
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (!cmpIdentity)
			continue;
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		if (cmpUnitAI && cmpUnitAI.IsFormationController())
			continue;
		const name = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(ent));
		let key = name;
		let owner;
		if (withOwner)
		{
			const cmpOwnership = Engine.QueryInterface(ent, IID_Ownership);
			owner = cmpOwnership ? cmpOwnership.GetOwner() : -1;
			key = owner + ":" + name;
		}
		let group = groups.get(key);
		if (!group)
		{
			group = { "name": name, "n": 0, "cells": {}, "doing": {}, "hurt": 0 };
			if (withOwner)
				group.owner = owner;
			groups.set(key, group);
		}
		++group.n;
		const pos = AgentiumPosition(ent);
		if (pos)
		{
			const cell = AgentiumCell(pos.x, pos.z, mapSize);
			group.cells[cell] = (group.cells[cell] || 0) + 1;
		}
		const activity = AgentiumActivity(ent, cmpUnitAI);
		group.doing[activity] = (group.doing[activity] || 0) + 1;
		const cmpHealth = Engine.QueryInterface(ent, IID_Health);
		if (cmpHealth && cmpHealth.GetHitpoints() < 0.6 * cmpHealth.GetMaxHitpoints())
			++group.hurt;
	}
	const list = Array.from(groups.values()).sort((a, b) => b.n - a.n).slice(0, maxGroups);
	for (const group of list)
	{
		group.cells = Object.keys(group.cells).sort((a, b) => group.cells[b] - group.cells[a]).slice(0, 3);
		if (!group.hurt)
			delete group.hurt;
		if (Object.keys(group.doing).length == 1 && group.doing.static !== undefined)
			delete group.doing;
	}
	return list;
}

/**
 * Entities of a player split into units and structures (foundations included).
 */
function AgentiumOwnEntities(player)
{
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	const units = [];
	const structures = [];
	for (const ent of cmpRangeManager.GetEntitiesByPlayer(player))
	{
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (!cmpIdentity)
			continue;
		if (cmpIdentity.HasClass("Structure"))
			structures.push(ent);
		else if (cmpIdentity.HasClass("Unit"))
			units.push(ent);
	}
	return { "units": units, "structures": structures };
}

function AgentiumCivicCentre(player)
{
	const own = AgentiumOwnEntities(player);
	let best;
	for (const ent of own.structures)
	{
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (cmpIdentity.HasClass("CivilCentre") && !Engine.QueryInterface(ent, IID_Foundation))
			return ent;
		if (!best && cmpIdentity.HasClass("Dropsite"))
			best = ent;
	}
	return best || own.structures[0];
}

/**
 * Nearest explored gaia resource supplies per generic resource type.
 */
function AgentiumNearbyResources(player, origin, mapSize, perType = 2)
{
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const byType = {};
	if (!origin)
		return byType;
	for (const ent of cmpRangeManager.GetEntitiesByPlayer(0))
	{
		const cmpSupply = Engine.QueryInterface(ent, IID_ResourceSupply);
		if (!cmpSupply)
			continue;
		const pos = AgentiumPosition(ent);
		if (!pos)
			continue;
		if (cmpRangeManager.GetLosVisibility(ent, player) == "hidden")
			continue;
		const type = cmpSupply.GetType();
		const generic = type.generic;
		const entry = {
			"id": ent,
			"name": AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(ent)),
			"cell": AgentiumCell(pos.x, pos.z, mapSize),
			"amount": cmpSupply.GetCurrentAmount(),
			"dist": Math.round(AgentiumDistance(origin, pos))
		};
		if (!byType[generic])
			byType[generic] = [];
		byType[generic].push(entry);
	}
	for (const generic in byType)
	{
		byType[generic].sort((a, b) => a.dist - b.dist);
		byType[generic] = byType[generic].slice(0, perType);
	}
	return byType;
}

/**
 * What the player could train, build and research right now.
 */
function AgentiumOptions(player, own, resourceCounts)
{
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const cmpTechnologyManager = QueryPlayerIDInterface(player, IID_TechnologyManager);

	const train = new Map();
	const research = new Map();
	for (const ent of own.structures)
	{
		if (Engine.QueryInterface(ent, IID_Foundation))
			continue;
		const where = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(ent));
		const cmpTrainer = Engine.QueryInterface(ent, IID_Trainer);
		if (cmpTrainer)
			for (const templateName of cmpTrainer.GetEntitiesList())
			{
				if (cmpTechnologyManager && !cmpTechnologyManager.CanProduce(templateName))
					continue;
				const name = AgentiumShortName(templateName);
				if (!train.has(name))
				{
					const cost = AgentiumTemplateCost(templateName);
					train.set(name, { "name": name, "at": where, "cost": cost, "affordable": AgentiumAffordable(cost, resourceCounts) });
				}
			}
		const cmpResearcher = Engine.QueryInterface(ent, IID_Researcher);
		if (cmpResearcher)
			for (const item of cmpResearcher.GetTechnologiesList())
			{
				if (!item)
					continue;
				const techs = typeof item == "object" ? [item.top, item.bottom] : [item];
				for (const tech of techs)
				{
					if (!tech || research.has(tech))
						continue;
					if (cmpTechnologyManager && !cmpTechnologyManager.CanResearch(tech))
						continue;
					const cost = AgentiumTechCost(tech);
					research.set(tech, { "name": tech, "at": where, "cost": cost, "affordable": AgentiumAffordable(cost, resourceCounts) });
				}
			}
	}

	const build = new Map();
	for (const ent of own.units)
	{
		const cmpBuilder = Engine.QueryInterface(ent, IID_Builder);
		if (!cmpBuilder)
			continue;
		for (const templateName of cmpBuilder.GetEntitiesList())
		{
			if (cmpTechnologyManager && !cmpTechnologyManager.CanProduce(templateName))
				continue;
			const name = AgentiumShortName(templateName);
			if (!build.has(name))
			{
				const cost = AgentiumTemplateCost(templateName);
				build.set(name, { "name": name, "cost": cost, "affordable": AgentiumAffordable(cost, resourceCounts) });
			}
		}
		// Builder lists are per civ, one worker is representative.
		if (build.size)
			break;
	}

	const trim = (map, max) => Array.from(map.values())
		.sort((a, b) => (b.affordable - a.affordable))
		.slice(0, max);
	return {
		"train": trim(train, AGENTIUM_MAX_OPTIONS.train),
		"build": trim(build, AGENTIUM_MAX_OPTIONS.build),
		"research": trim(research, AGENTIUM_MAX_OPTIONS.research)
	};
}

/**
 * Enemy entities the player can currently see (units) or has seen (structures stay
 * visible in the fog as the player last saw them).
 */
function AgentiumEnemies(player, mapSize)
{
	const cmpRangeManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager);
	const cmpDiplomacy = QueryPlayerIDInterface(player, IID_Diplomacy);
	const units = [];
	const structures = [];
	for (const ent of cmpRangeManager.GetNonGaiaEntities())
	{
		const cmpOwnership = Engine.QueryInterface(ent, IID_Ownership);
		if (!cmpOwnership)
			continue;
		const owner = cmpOwnership.GetOwner();
		if (owner == player || owner <= 0 || (cmpDiplomacy && !cmpDiplomacy.IsEnemy(owner)))
			continue;
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (!cmpIdentity)
			continue;
		const visibility = cmpRangeManager.GetLosVisibility(ent, player);
		if (cmpIdentity.HasClass("Structure"))
		{
			if (visibility != "hidden")
				structures.push(ent);
		}
		else if (visibility == "visible")
			units.push(ent);
	}
	return {
		"units": AgentiumGroupUnits(units, mapSize, true, 12),
		"structures": AgentiumGroupUnits(structures, mapSize, true, 12)
	};
}

function AgentiumProduction(own)
{
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const list = [];
	for (const ent of own.structures)
	{
		const cmpQueue = Engine.QueryInterface(ent, IID_ProductionQueue);
		if (!cmpQueue)
			continue;
		const queue = cmpQueue.GetQueue();
		if (!queue.length)
			continue;
		const where = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(ent));
		for (const item of queue.slice(0, 3))
			list.push({
				"at": where,
				"item": item.technologyTemplate || AgentiumShortName(item.unitTemplate),
				"count": item.count || 1,
				"progress": Math.round((item.progress || 0) * 100) / 100
			});
	}
	return list.slice(0, 10);
}

function AgentiumStructures(own, mapSize)
{
	const cmpTemplateManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_TemplateManager);
	const groups = new Map();
	for (const ent of own.structures)
	{
		const name = AgentiumShortName(cmpTemplateManager.GetCurrentTemplateName(ent)).replace(/^foundation\|/, "");
		const cmpFoundation = Engine.QueryInterface(ent, IID_Foundation);
		const key = name + (cmpFoundation ? "#f" : "");
		let group = groups.get(key);
		if (!group)
		{
			group = { "name": name, "n": 0, "ids": [], "cells": {} };
			if (cmpFoundation)
				group.under_construction = [];
			groups.set(key, group);
		}
		++group.n;
		if (group.ids.length < 4)
			group.ids.push(ent);
		const pos = AgentiumPosition(ent);
		if (pos)
		{
			const cell = AgentiumCell(pos.x, pos.z, mapSize);
			group.cells[cell] = (group.cells[cell] || 0) + 1;
		}
		if (cmpFoundation && group.under_construction.length < 4)
			group.under_construction.push(Math.round(cmpFoundation.GetBuildPercentage()));
		const cmpHealth = Engine.QueryInterface(ent, IID_Health);
		if (cmpHealth && !cmpFoundation && cmpHealth.GetHitpoints() < 0.6 * cmpHealth.GetMaxHitpoints())
			group.damaged = (group.damaged || 0) + 1;
	}
	const list = Array.from(groups.values()).sort((a, b) => b.n - a.n).slice(0, AGENTIUM_MAX_GROUPS);
	for (const group of list)
		group.cells = Object.keys(group.cells).sort((a, b) => group.cells[b] - group.cells[a]).slice(0, 3);
	return list;
}

/**
 * The compact view of @param player's situation.
 */
function AgentiumView(player)
{
	const cmpGuiInterface = Engine.QueryInterface(SYSTEM_ENTITY, IID_GuiInterface);
	const sim = cmpGuiInterface.GetSimulationState();
	const me = sim.players[player];
	if (!me)
		return { "error": "no such player " + player };
	const mapSize = sim.mapSize || AgentiumMapSize();
	const own = AgentiumOwnEntities(player);
	const cc = AgentiumCivicCentre(player);
	const ccPos = cc ? AgentiumPosition(cc) : undefined;

	const resourceCounts = {};
	for (const res in me.resourceCounts)
		resourceCounts[res] = Math.floor(me.resourceCounts[res]);
	const gatherers = {};
	for (const res in me.resourceGatherers)
		if (me.resourceGatherers[res])
			gatherers[res] = me.resourceGatherers[res];

	const units = AgentiumGroupUnits(own.units, mapSize, false);
	const idle = { "workers": 0, "military": 0 };
	for (const ent of own.units)
	{
		const cmpUnitAI = Engine.QueryInterface(ent, IID_UnitAI);
		if (!cmpUnitAI || !cmpUnitAI.IsIdle() || cmpUnitAI.IsFormationController())
			continue;
		const cmpIdentity = Engine.QueryInterface(ent, IID_Identity);
		if (Engine.QueryInterface(ent, IID_Builder) || cmpIdentity.HasClass("Support"))
			++idle.workers;
		else if (!cmpUnitAI.IsAnimal())
			++idle.military;
	}

	const enemies = AgentiumEnemies(player, mapSize);
	const attacks = cmpGuiInterface.GetIncomingAttacks(player).slice(-5).map(a => {
		const cmpOwnership = a.attacker && Engine.QueryInterface(a.attacker, IID_Ownership);
		return {
			"cell": a.position ? AgentiumCell(a.position.x, a.position.z, mapSize) : undefined,
			"attacker_owner": cmpOwnership ? cmpOwnership.GetOwner() : undefined,
			"seconds_ago": a.time !== undefined ? Math.round((sim.timeElapsed - a.time) / 1000) : undefined
		};
	});

	const view = {
		"time_s": Math.round(sim.timeElapsed / 1000),
		"player": player,
		"civ": me.civ,
		"phase": me.phase,
		"pop": me.popCount + "/" + me.popLimit,
		"resources": resourceCounts,
		"gatherers": gatherers,
		"state": me.state,
		"map": { "size": mapSize, "grid": AGENTIUM_GRID + "x" + AGENTIUM_GRID + " cells A1..L" + AGENTIUM_GRID },
		"cc": cc ? { "id": cc, "cell": ccPos ? AgentiumCell(ccPos.x, ccPos.z, mapSize) : undefined } : null,
		"units": units,
		"idle": idle,
		"structures": AgentiumStructures(own, mapSize),
		"production": AgentiumProduction(own),
		"research_in_progress": (me.researchQueued ? Object.keys(me.researchQueued) : []).slice(0, 6),
		"enemy_units_visible": enemies.units,
		"enemy_structures_known": enemies.structures,
		"incoming_attacks": attacks,
		"battle": cmpGuiInterface.GetBattleState(player),
		"options": AgentiumOptions(player, own, resourceCounts),
		"resources_nearby": AgentiumNearbyResources(player, ccPos, mapSize)
	};
	if (me.trainingBlocked)
		view.training_blocked = true;
	return view;
}

/**
 * Match status for every player: who is still playing, who won or was defeated.
 */
function AgentiumStatus()
{
	const cmpGuiInterface = Engine.QueryInterface(SYSTEM_ENTITY, IID_GuiInterface);
	const sim = cmpGuiInterface.GetSimulationState();
	const players = [];
	for (let i = 1; i < sim.players.length; ++i)
	{
		const p = sim.players[i];
		const entry = { "id": i, "name": p.name, "civ": p.civ, "team": p.team, "state": p.state, "pop": p.popCount, "phase": p.phase };
		if (p.statistics)
		{
			entry.units_trained = p.statistics.unitsTrained;
			entry.units_lost = p.statistics.unitsLost;
			entry.enemy_units_killed = p.statistics.enemyUnitsKilled;
			entry.buildings_constructed = p.statistics.buildingsConstructed;
			entry.resources_gathered = p.statistics.resourcesGathered;
		}
		players.push(entry);
	}
	return { "time_s": Math.round(sim.timeElapsed / 1000), "players": players };
}

Engine.RegisterGlobal("AGENTIUM_GRID", AGENTIUM_GRID);
Engine.RegisterGlobal("AgentiumCell", AgentiumCell);
Engine.RegisterGlobal("AgentiumCellCenter", AgentiumCellCenter);
Engine.RegisterGlobal("AgentiumShortName", AgentiumShortName);
Engine.RegisterGlobal("AgentiumNameMatches", AgentiumNameMatches);
Engine.RegisterGlobal("AgentiumPosition", AgentiumPosition);
Engine.RegisterGlobal("AgentiumDistance", AgentiumDistance);
Engine.RegisterGlobal("AgentiumOwnEntities", AgentiumOwnEntities);
Engine.RegisterGlobal("AgentiumCivicCentre", AgentiumCivicCentre);
Engine.RegisterGlobal("AgentiumMapSize", AgentiumMapSize);
Engine.RegisterGlobal("AgentiumTemplateCost", AgentiumTemplateCost);
Engine.RegisterGlobal("AgentiumView", AgentiumView);
Engine.RegisterGlobal("AgentiumStatus", AgentiumStatus);
