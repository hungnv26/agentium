import { Plugin } from 'tools/dap/plugin.js';

class BreakpointManager extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('BreakpointManager', 'manager');
		this.breakpoints = [];

		this.dbg = jsDebugger.instance;
		this.jsDebugger = jsDebugger;
		this.logger.debug('Setting up BreakpointManager');
		jsDebugger.on('onNewScript', ({ script, global }) => {
			if (!jsDebugger.debuggerAttached)
				return;

			this.logger.debug(`New script loaded: ${script.url}`);
			const url = script.url;

			if (!this.addBreakpointsByPath(url, script))
				return;

			const index = this.breakpoints.findIndex((bp) => bp.url === url);
			if (index === -1)
				return;

			this.logger.debug(`Setting breakpoints for script: ${script.url}`);
			const sourceReferenceIndex = jsDebugger.sourcesReferences.findIndex((src) => src.path === url);
			this.breakpoints[index].lines.forEach((bp, i) => {
				jsDebugger.pushEvent('breakpoint', {
					'reason': 'changed',
					'breakpoint': {
						'id': ((index + 1) * 1000) + i,
						'verified': bp.verified,
						'message': bp.message,
						'source': {
							'path': url,
							'sourceReference': sourceReferenceIndex + 1
						}
					}
				}, this.name);
			});
		}, this.name);

		jsDebugger.on('onDebuggerDetached', () => {
			this.logger.debug('Debugger detached');
			this.dbg.clearAllBreakpoints();
			this.breakpoints = [];
		}, this.name);

		dapHandler.registerCommand('setBreakpoints', (req) => {
			const path = req.arguments.source.path;
			const name = req.arguments.source.name;
			this.logger.debug(`Handling setBreakpoints command for source: ${req.arguments.source.path}`);

			if (!path)
			{
				this.logger.error('Invalid source path or name');
				return dapHandler.errorResponse(req, 'Invalid source path or name');
			}

			const index = this.createOrUpdateBreakpoint(name, path, req.arguments.breakpoints.map((bp) => ({ 'line': bp.line })));
			this.addBreakpointsByPath(path);

			const sourceReferenceIndex = jsDebugger.sourcesReferences.findIndex((src) => src.path === path);
			const responses = this.breakpoints[index - 1].lines.map((bp, i) => ({
				'id': (index * 1000) + i,
				'verified': bp.verified ?? false,
				'reason': bp.verified ? null : 'pending',
				'message': bp.verified ? null: bp.message,
				'source': {
					'path': path,
					'sourceReference': sourceReferenceIndex + 1
				}
			}));

			return dapHandler.successResponse(req, { 'breakpoints': responses });
		});
	}

	createOrUpdateBreakpoint(name, url, lines) {
		let index = this.breakpoints.findIndex((bp) => (!name || bp.name === name) && bp.url === url);
		if (index === -1)
		{
			this.breakpoints.push({ name, 'url': url, lines });
			index = this.breakpoints.length - 1;
		}
		else
			this.breakpoints[index].lines = lines;

		return index + 1;
	}

	addBreakpointsByPath(path, instance_script) {
		const infoBk = this.breakpoints.find((bp) => bp.url === path);

		if (!infoBk)
			return false;

		const scripts = instance_script ? [instance_script] : this.dbg.findScripts({ 'url': path });
		if (scripts.length === 0)
			return false;

		this.logger.trace(`Found ${scripts.length} scripts for path: ${path}`);
		this.scriptTreeWalk(scripts, (script) => {
			script.clearAllBreakpoints();
		});

		infoBk.lines.forEach((bp) => {
			this.logger.debug(`Setting breakpoint at: ${uneval(bp)}`);
			bp.verified = false;
			bp.message = "No offset found";
			this.scriptTreeWalk(scripts, (script) => {
				const offsets = script.getPossibleBreakpointOffsets({
					'line': bp.line,
				});

				// Continue walking the tree.
				if (offsets.length === 0)
					return true;

				this.logger.debug(`Setted breakpoint at: ${uneval(offsets[0])}`);
				script.setBreakpoint(offsets[0], { 'hit': this.handleBreakpoint.bind(this) });
				bp.verified = true;
				bp.message = "Breakpoint set";
				// Stop walking the tree.
				return false;
			});
		});
		return true;
	}

	scriptTreeWalk(script, callback) {
		if (!script || script.length === 0)
			return;

		const queue = [...script];
		while (queue.length > 0)
		{
			const currentScript = queue.shift();
			if (callback(currentScript) === false)
				return;
			queue.push(...currentScript.getChildScripts());
			this.logger.trace(`Queue length: ${queue.length}`);
		}
	}

	handleBreakpoint(frame) {
		this.jsDebugger.stopInframe(frame, () => {
			this.jsDebugger.pushEvent('stopped', {
				'reason': 'breakpoint',
				'threadId': 1,
				'text': "Paused on breakpoint"
			}, this.name);
		});
	}
}

export default BreakpointManager;
