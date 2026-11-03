/**
 * This page allows to mix color using sliders one for each of three channels in range of 0 to 255 with
 * step of 1, returning sanitized color when closing
 */

const labels = [translate("Red"), translate("Green"), translate("Blue")];
const captions = [translate("Cancel"), translate("Save")];

function resizeChanel(i)
{
	const object0 = Engine.GetGUIObjectByName("color[0]");
	const height0 = object0.size.bottom - object0.size.top;
	const object = Engine.GetGUIObjectByName("color[" + i + "]");

	object.size.top = i * height0;
	object.size.bottom = (i + 1) * height0;
}

async function initializeButtons()
{
	const button = [];
	const prom = setButtonCaptionsAndVisibility(button, captions,
		Engine.GetGUIObjectByName("cancelHotkey"), "cmButton");
	distributeButtonsHorizontally(button, captions);
	return {
		"done": true,
		"value": await prom
	};
}

/**
 * @param {String} initialColor - initial color as RGB string e.g. 100 0 200
 */
export async function init(initialColor)
{
	Engine.GetGUIObjectByName("titleBar").caption = translate("Color");
	Engine.GetGUIObjectByName("infoLabel").caption =
		translate("Move the sliders to change the Red, Green and Blue components of the Color");

	const closePromise = initializeButtons();

	const splitColor = initialColor.split(" ");

	const chanels = labels.map((label, i) => {
		Engine.GetGUIObjectByName("colorLabel[" + i + "]").caption = label;
		resizeChanel(i);

		const color = Math.floor(+splitColor[i] || 0);

		const valueText = Engine.GetGUIObjectByName("colorValue[" + i + "]");
		valueText.caption = color;

		const slider = Engine.GetGUIObjectByName("colorSlider[" + i + "]");
		slider.min_value = 0;
		slider.max_value = 255;
		slider.value = color;

		return {
			"slider": slider,
			"color": color,
			"valueText": valueText
		};
	});

	// Update return color on cancel to prevent malformed values from initial input.
	const currentColor = () => chanels.map(chanel => chanel.color).join(" ");
	const sanitizedColor = currentColor();

	const colorDisplay = Engine.GetGUIObjectByName("colorDisplay");
	while (true)
	{
		colorDisplay.sprite = "color:" + currentColor();
		const chanelPromises = chanels.map(chanel => {
			return new Promise(resolve => {
				chanel.slider.onValueChange = resolve.bind(undefined, { "value": chanel });
			});
		});

		const result = await Promise.race([...chanelPromises, closePromise]);

		if (result.done)
			return result.value === 0 ? sanitizedColor : currentColor();

		const chanel = result.value;
		chanel.color = Math.floor(chanel.slider.value);
		chanel.valueText.caption = chanel.color;
	}
}
