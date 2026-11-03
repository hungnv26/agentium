await undefined;
// `import "blabbermouth.js";` would be hoisted before the await resulting in it not being delayed.
log("blah blah blah");
