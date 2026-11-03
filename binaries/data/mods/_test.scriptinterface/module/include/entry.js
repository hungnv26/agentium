import RenamedCircle from "include/circle.js";

const area = new RenamedCircle(10).area;

if (area === (Math.PI * 100))
	log("Test succeeded");
else
	throw new Error("Module Evalutation Error");
