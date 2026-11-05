/**
 * Agentium battle mode: every player starts ready to fight. At the start of the game each
 * player is advanced to the city phase, every technology their civilization can research is
 * researched, and the population limit no longer depends on houses. Together with a large
 * StartingResources setting this removes the economy from the match: no farming or mining,
 * only building an army and fighting.
 *
 * It is a trigger script (listed in the game's TriggerScripts), so it runs inside the
 * simulation at the same turn in the game and in its replay.
 */
Trigger.prototype.AgentiumBattleSetup = function()
{
	const cmpPlayerManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_PlayerManager);
	const cmpPopulationCapManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_PopulationCapManager);
	const techNames = TechnologyTemplates.GetNames().slice().sort();
	const numPlayers = cmpPlayerManager.GetNumPlayers();

	for (let player = 1; player < numPlayers; ++player)
	{
		const playerEnt = cmpPlayerManager.GetPlayerByID(player);
		const cmpPlayer = Engine.QueryInterface(playerEnt, IID_Player);
		const cmpTechnologyManager = Engine.QueryInterface(playerEnt, IID_TechnologyManager);
		const cmpIdentity = Engine.QueryInterface(playerEnt, IID_Identity);
		if (!cmpPlayer || !cmpTechnologyManager || !cmpIdentity)
			continue;

		// The population limit: as if every house were already built.
		cmpPlayer.SetPopulationBonuses(cmpPopulationCapManager.GetPopulationCap() + 500);

		// Phases first (their structure-count requirements are skipped on purpose).
		const civ = cmpIdentity.GetCiv();
		for (const phase of ["phase_town", "phase_city"])
			cmpTechnologyManager.ResearchTechnology(phase + (TechnologyTemplates.Has(phase + "_" + civ) ? "_" + civ : "_generic"));

		// Then every technology whose requirements are met, in passes, since researching one
		// can unlock the next. Of a pair of exclusive technologies the first by name is taken.
		let researched = 0;
		for (let pass = 0; pass < 12; ++pass)
		{
			let progress = false;
			for (const tech of techNames)
			{
				const template = TechnologyTemplates.Get(tech);
				if (!template || template.top || template.bottom || template.autoResearch)
					continue;
				if (!cmpTechnologyManager.CanResearch(tech))
					continue;
				cmpTechnologyManager.ResearchTechnology(tech);
				++researched;
				progress = true;
			}
			if (!progress)
				break;
		}
		this.agentiumBattleResearched[player] = researched;
	}
};

{
	const cmpTrigger = Engine.QueryInterface(SYSTEM_ENTITY, IID_Trigger);
	cmpTrigger.agentiumBattleResearched = {};
	cmpTrigger.DoAfterDelay(0, "AgentiumBattleSetup", null);
}
