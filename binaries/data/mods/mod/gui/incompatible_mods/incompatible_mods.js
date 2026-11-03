var g_IncompatibleModsFile = "gui/incompatible_mods/incompatible_mods.txt";

function init(data)
{
	Engine.GetGUIObjectByName("mainText").caption = Engine.TranslateLines(Engine.ReadFile(g_IncompatibleModsFile));
	return new Promise(closePageCallback => {
		Engine.GetGUIObjectByName("btnClose").onPress = closePageCallback;
	});
}
