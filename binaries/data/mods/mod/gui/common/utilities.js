function distributeButtonsHorizontally(button, captions)
{
	const y1 = "100%-46";
	const y2 = "100%-18";
	switch (captions.length)
	{
	case 1:
		button[0].size = "18 " + y1 + " 100%-18 " + y2;
		break;
	case 2:
		button[0].size = "18 " + y1 + " 50%-5 " + y2;
		button[1].size = "50%+5 " + y1 + " 100%-18 " + y2;
		break;
	case 3:
		button[0].size = "18 " + y1 + " 33%-5 " + y2;
		button[1].size = "33%+5 " + y1 + " 66%-5 " + y2;
		button[2].size = "66%+5 " + y1 + " 100%-18 " + y2;
		break;
	default:
		error("distributeButtonsHorizontally does not yet support more than 3 buttons, attempting to use " + captions.length);
	}
}

function setButtonCaptionsAndVisibility(buttons, captions, cancelHotkey, name)
{
	return new Promise(resolve => {
		captions.forEach((caption, i) => {
			buttons[i] = Engine.GetGUIObjectByName(name + (i + 1));
			buttons[i].caption = caption;
			buttons[i].hidden = false;
			buttons[i].onPress = resolve.bind(null, i);

		});
		cancelHotkey.onPress = buttons[0].onPress;
	});
}
