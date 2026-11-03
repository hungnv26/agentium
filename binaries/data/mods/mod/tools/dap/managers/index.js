import AttachManager from 'tools/dap/managers/attach.js';
import BreakpointManager from 'tools/dap/managers/breakpoint.js';
import FrameManager from 'tools/dap/managers/frame.js';
import InspectorManager from 'tools/dap/managers/inspector.js';
import SourcesManager from 'tools/dap/managers/sources.js';

// This allow define depedencies between plugins
// and load them in the correct order.
export const plugins = [
	AttachManager,
	SourcesManager,
	BreakpointManager,
	FrameManager,
	InspectorManager,
];
