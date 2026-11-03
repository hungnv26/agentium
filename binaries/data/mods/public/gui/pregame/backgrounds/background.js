/**
 * Agentium main-menu background: a wide shot of a Persian town under attack,
 * rendered in-engine from the "Cinema Demo" scenario. A single layer that
 * drifts slowly; the image is twice as wide as it is tall so it covers
 * 16:9 and 16:10 windows without gaps.
 */
export const backgrounds = {
	"agentium": [
		{
			"offset": (time, width) => 0.035 * width * Math.cos(0.04 * time),
			"sprite": "background-agentium1-1",
			"tiling": false,
		},
	]
};
