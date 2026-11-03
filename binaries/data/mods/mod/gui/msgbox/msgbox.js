/**
 * Currently limited to at most 3 buttons per message box.
 * The convention is to have "cancel" appear first.
 */
function init(data)
{
	// Set title
	Engine.GetGUIObjectByName("mbTitleBar").caption = data.title;

	// Set subject
	const mbTextObj = Engine.GetGUIObjectByName("mbText");
	mbTextObj.caption = data.message;
	if (data.font)
		mbTextObj.font = data.font;

	// Default behaviour
	const mbCancelHotkey = Engine.GetGUIObjectByName("mbCancelHotkey");

	// Calculate size
	const mbLRDiff = data.width / 2;
	const mbUDDiff = data.height / 2;
	Engine.GetGUIObjectByName("mbMain").size = "50%-" + mbLRDiff + " 50%-" + mbUDDiff + " 50%+" + mbLRDiff + " 50%+" + mbUDDiff;

	const captions = data.buttonCaptions || [translate("OK")];

	const mbButton = [];
	const closePromise = setButtonCaptionsAndVisibility(mbButton, captions, mbCancelHotkey, "mbButton");
	distributeButtonsHorizontally(mbButton, captions);

	return closePromise;
}
