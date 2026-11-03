function init(data)
{
	Engine.GetGUIObjectByName("mainText").caption = Engine.TranslateLines(Engine.ReadFile("gui/modmod/help/help.txt"));
	return new Promise(closePageCallback => {
		Engine.GetGUIObjectByName("closeButton").onPress = closePageCallback;
	});
}
