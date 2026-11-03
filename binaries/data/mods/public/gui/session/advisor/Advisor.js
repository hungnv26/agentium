/**
 * Agentium advisor: every few seconds (or on request) the viewed player's situation
 * (GuiInterface GetAgentiumView) is sent to an AI model through the Arena's key gateway,
 * and the model's suggestions are shown as orders the player can apply. Applying an order
 * resolves it in the simulation (ResolveAgentiumOrder) and posts the resulting commands like
 * any player command, so it is recorded in the replay.
 *
 * Needs the engine's HTTP bridge (Engine.HttpRequest*), which is off unless the config has
 *   http.enabled = "true"
 *   advisor.enabled = "true"
 *   advisor.token = "<the arena token, arena/.data/arena.token>"
 * and optionally advisor.url (default http://127.0.0.1:8895/advisor/turn), advisor.model
 * (default anthropic:claude-haiku-5-5), advisor.interval (seconds, default 45, 0 = only on request),
 * advisor.open ("true" opens the panel when the game starts), advisor.autoapply ("true" applies
 * every suggestion itself: the model plays your side).
 */
class Advisor
{
	constructor(playerViewControl)
	{
		this.playerViewControl = playerViewControl;
		this.panel = Engine.GetGUIObjectByName("advisorPanel");
		this.toggle = Engine.GetGUIObjectByName("advisorToggle");
		this.text = Engine.GetGUIObjectByName("advisorText");
		this.status = Engine.GetGUIObjectByName("advisorStatus");
		this.orderRows = [];
		for (let i = 0; i < this.MaxOrders; ++i)
			this.orderRows.push({
				"row": Engine.GetGUIObjectByName("advisorOrder[" + i + "]"),
				"text": Engine.GetGUIObjectByName("advisorOrderText[" + i + "]"),
				"apply": Engine.GetGUIObjectByName("advisorOrderApply[" + i + "]")
			});

		this.enabled = this.isConfigured();
		// advisor.autoapply = "true": the advisor plays your side, applying every suggestion itself.
		this.autoApply = Engine.ConfigDB_GetValue("user", "advisor.autoapply") == "true";
		this.model = Engine.ConfigDB_GetValue("user", "advisor.model") || "anthropic:claude-haiku-5-5";
		this.url = Engine.ConfigDB_GetValue("user", "advisor.url") || "http://127.0.0.1:8895/advisor/turn";
		this.token = Engine.ConfigDB_GetValue("user", "advisor.token");
		const interval = Engine.ConfigDB_GetValue("user", "advisor.interval");
		this.intervalMs = (interval === "" ? 45 : +interval) * 1000;

		this.suggestions = [];
		this.results = [];
		this.request = 0;
		this.usd = 0;
		this.turns = 0;
		this.lastAskedAt = 0;

		this.toggle.hidden = !this.enabled;
		// advisor.open = "true" shows the panel from the start (handy for testing).
		this.panel.hidden = !(this.enabled && Engine.ConfigDB_GetValue("user", "advisor.open") == "true");
		this.toggle.onPress = () => this.togglePanel();
		Engine.GetGUIObjectByName("advisorClose").onPress = () => this.togglePanel();
		Engine.GetGUIObjectByName("advisorAsk").onPress = () => this.ask();
		Engine.GetGUIObjectByName("advisorApplyAll").onPress = () => this.applyAll();
		this.orderRows.forEach((row, i) => { row.apply.onPress = () => this.apply(i); });

		if (this.enabled)
			this.setStatus(sprintf(translate("%(model)s, waiting"), { "model": this.model }));
		this.layout();
		if (this.enabled)
			this.schedule(500);
	}

	isConfigured()
	{
		return Engine.HttpEnabled() &&
			Engine.ConfigDB_GetValue("user", "advisor.enabled") == "true" &&
			!!Engine.ConfigDB_GetValue("user", "advisor.token");
	}

	canControl()
	{
		return !g_IsObserver && g_ViewedPlayer > 0 && g_ViewedPlayer == Engine.GetPlayerID();
	}

	togglePanel()
	{
		this.panel.hidden = !this.panel.hidden;
		if (!this.panel.hidden && !this.turns && !this.request)
			this.ask();
	}

	setStatus(text)
	{
		this.status.caption = text;
	}

	schedule(delayMs)
	{
		if (this.timer)
			clearTimeout(this.timer);
		this.timer = setTimeout(() => this.tick(), delayMs);
	}

	tick()
	{
		this.timer = undefined;
		if (!this.enabled)
			return;
		if (this.request)
			this.poll();
		else if (this.intervalMs > 0 && Date.now() - this.lastAskedAt >= this.intervalMs && !g_IsNetworked)
			this.ask();
		this.schedule(this.request ? 300 : 1000);
	}

	/**
	 * Send the current situation to the model.
	 */
	ask()
	{
		if (!this.enabled || this.request)
			return;
		const player = g_ViewedPlayer;
		if (player <= 0)
		{
			this.setStatus(translate("Select a player to advise."));
			return;
		}
		const view = Engine.GuiInterfaceCall("GetAgentiumView", player);
		const body = JSON.stringify({
			"model": this.model,
			"player": player,
			"name": g_Players[player] ? g_Players[player].name : "Player " + player,
			"civ": view.civ,
			"minutes": 0,
			"view": view,
			"results": this.results
		});
		this.request = Engine.HttpRequestStart(this.url, "POST", body, [
			"Content-Type: application/json",
			"X-Arena-Token: " + this.token
		]);
		this.lastAskedAt = Date.now();
		if (!this.request)
			this.setStatus(translate("Request refused: check http.enabled and http.allowlist."));
		else
			this.setStatus(sprintf(translate("%(model)s is thinking..."), { "model": this.model }));
		this.schedule(300);
	}

	poll()
	{
		const r = Engine.HttpRequestPoll(this.request);
		if (r.status == "pending")
			return;
		this.request = 0;
		if (r.status != "done" || r.httpStatus != 200)
		{
			let message = r.error || ("HTTP " + r.httpStatus);
			try
			{
				const err = JSON.parse(r.body);
				if (err && err.error && err.error.message)
					message = err.error.message;
			}
			catch (e) {}
			this.setStatus(sprintf(translate("Advisor failed: %(error)s"), { "error": message.slice(0, 120) }));
			return;
		}
		let reply;
		try
		{
			reply = JSON.parse(r.body);
		}
		catch (e)
		{
			this.setStatus(translate("Advisor returned something that is not JSON."));
			return;
		}
		++this.turns;
		this.usd += reply.usd || 0;
		this.suggestions = (reply.orders || []).slice(0, this.MaxOrders);
		this.results = [];
		this.text.caption = reply.text || (this.suggestions.length ? translate("Suggested orders:") : translate("No suggestions this time."));
		this.setStatus(sprintf(translate("%(model)s, turn %(turn)s, $%(usd)s"), { "model": this.model, "turn": this.turns, "usd": this.usd.toFixed(3) }));
		this.layout();
		if (this.autoApply)
			this.applyAll();
	}

	describe(order)
	{
		const args = Object.keys(order.args || {}).map(k => k + "=" + (Array.isArray(order.args[k]) ? order.args[k].join("+") : order.args[k])).join(", ");
		return order.tool + "(" + args + ")";
	}

	layout()
	{
		const canApply = this.canControl();
		this.orderRows.forEach((row, i) => {
			const s = this.suggestions[i];
			row.row.hidden = !s;
			if (!s)
				return;
			row.row.size = "0 " + (i * 28) + " 100% " + (i * 28 + 26);
			row.text.caption = (s.applied ? (s.ok ? "[color=\"120 220 120\"]✓[/color] " : "[color=\"230 100 100\"]✗[/color] ") : "") + this.describe(s) + (s.message ? "  —  " + s.message : "");
			row.apply.hidden = !canApply || !!s.applied;
		});
		Engine.GetGUIObjectByName("advisorApplyAll").hidden = !canApply || !this.suggestions.some(s => !s.applied);
	}

	/**
	 * Resolve one suggestion in the simulation and post its commands.
	 */
	apply(i)
	{
		const s = this.suggestions[i];
		if (!s || s.applied || !this.canControl())
			return;
		const order = Object.assign({ "order": s.tool }, s.args || {});
		const r = Engine.GuiInterfaceCall("ResolveAgentiumOrder", order);
		s.applied = true;
		s.ok = !!r.ok;
		s.message = r.message;
		if (r.ok)
			for (const cmd of r.commands || [])
				Engine.PostNetworkCommand(cmd);
		this.results.push(this.describe(s) + ": " + (r.ok ? "done" : "refused") + ": " + r.message);
		this.layout();
	}

	applyAll()
	{
		this.suggestions.forEach((s, i) => this.apply(i));
	}
}

Advisor.prototype.MaxOrders = 6;
