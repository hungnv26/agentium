function init()
{
	return new Promise(closePageCallback => { globalThis.closePageCallback = closePageCallback; });
}
