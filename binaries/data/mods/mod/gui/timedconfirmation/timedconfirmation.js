/**
 * @class TimedConfirmation
 * This class displays confirmation box, which will be closed after defined time in miliseconds.
 */
class TimedConfirmation
{
	messageObject = Engine.GetGUIObjectByName("tmcText");
	panel = Engine.GetGUIObjectByName("tmcMain");

	constructor()
	{
		this.panel.onTick = this.onTick.bind(this);
	}

	/**
	 * @param {Object} data
	 * @param {Number} data.width - The width of the confirmation box
	 * @param {Number} data.height - The height of the confirmation box
	 * @param {String} data.message - The message to be displayed with parameter for time which will be displayed in seconds
	 * @param {String} data.timeParameter - The string used in 'message' for time, e.g 'time' with %(time)s in message
	 * @param {Number} data.timeout - The time in miliseconds after which confirmation box closes itself
	 * @param {String} data.title - The string displayed in header
	 * @param {String|undefined} data.buttonCaptions - The captions used for buttons (if not defined, defaults to 'OK')
	 * @param {String|undefined} data.font - The used font
	 */
	setup(data)
	{
		Engine.GetGUIObjectByName("tmcTitleBar").caption = data.title;

		this.timeout = +data.timeout + Date.now();
		this.message = data.message;
		this.timeParameter = data.timeParameter;

		if (data.font)
			this.messageObject.font = data.font;

		this.updateDisplayedTimer(data.timeout);

		const cancelHotkey = Engine.GetGUIObjectByName("tmcCancelHotkey");

		const lRDiff = data.width / 2;
		const uDDiff = data.height / 2;
		this.panel.size = "50%-" + lRDiff + " 50%-" + uDDiff + " 50%+" + lRDiff + " 50%+" + uDDiff;

		const captions = data.buttonCaptions || [translate("OK")];

		const button = [];
		const closePromise =
			setButtonCaptionsAndVisibility(button, captions, cancelHotkey, "tmcButton");
		distributeButtonsHorizontally(button, captions);
		return closePromise;
	}

	onTick()
	{
		const remaining = this.timeout - Date.now();
		if (remaining < 1)
			Engine.GetGUIObjectByName("tmcButton1").onPress();

		this.updateDisplayedTimer(remaining);
	}

	updateDisplayedTimer(time)
	{
		this.messageObject.caption = sprintf(
			this.message,
			{ [this.timeParameter]: Math.ceil(time / 1000) }
		);
	}
}

function init(data)
{
	return new TimedConfirmation().setup(data);
}
