import { circleArea } from "include/geometry/area.js";

class Circle
{
	radius;

	constructor(radius)
	{
		this.radius = radius;
	}

	get area()
	{
		return circleArea(this.radius);
	}
}

export default Circle;
