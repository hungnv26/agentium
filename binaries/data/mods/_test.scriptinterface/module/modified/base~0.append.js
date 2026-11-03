// Even though this is local to the module, it's visible to other appendixes.
function appendToResult(fun, str)
{
	return () => fun() + str;
}

fn = appendToResult(fn, "0");
