/**
 * Agentium: the ending of a watched match. Once the Arena has seen the end of a match it calls
 * /outro on the RL interface, which sends the "AgentiumOutro" event to this page: the game
 * freezes on its last moment, is held like that for a while, then the picture and the sound
 * fade out. The Arena closes the game when the fade is over.
 */
class Outro
{
	constructor()
	{
		this.curtain = Engine.GetGUIObjectByName("agentiumOutro");
		this.startTime = undefined;
		this.alpha = 0;

		this.curtain.onAgentiumOutro = this.start.bind(this);
		this.curtain.onTick = this.onTick.bind(this);
	}

	/**
	 * @param {number} holdSeconds - how long the frozen last moment stays on screen.
	 * @param {number} fadeSeconds - how long the fade to black takes afterwards.
	 */
	start(holdSeconds, fadeSeconds)
	{
		if (this.startTime !== undefined)
			return;

		this.holdTime = Math.max(0, +holdSeconds || 0) * 1000;
		this.fadeTime = Math.max(0, +fadeSeconds || 0) * 1000;
		this.startTime = Date.now();
		this.gain = +Engine.ConfigDB_GetValue("user", "sound.mastergain");
		if (isNaN(this.gain))
			this.gain = 1;

		// Freezes units, projectiles, water and particles; the camera stays free.
		Engine.SetPaused(true, false);

		this.curtain.sprite = "color: 0 0 0 0";
		this.curtain.hidden = false;
	}

	onTick()
	{
		if (this.startTime === undefined)
			return;

		const elapsed = Date.now() - this.startTime - this.holdTime;
		if (elapsed < 0)
			return;

		const t = this.fadeTime ? Math.min(1, elapsed / this.fadeTime) : 1;
		// Slow at both ends, so the fade neither starts nor ends abruptly.
		const eased = t * t * (3 - 2 * t);

		const alpha = Math.round(255 * eased);
		if (alpha == this.alpha)
			return;

		this.alpha = alpha;
		this.curtain.sprite = "color: 0 0 0 " + alpha;
		Engine.SetMasterGain(this.gain * (1 - eased));
	}
}
