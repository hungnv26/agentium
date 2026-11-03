if (import.meta.path !== "modified/base.js")
	throw new Error("import.meta.path should be the path of the base.");

fn = appendToResult(fn, "1");
