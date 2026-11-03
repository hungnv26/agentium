import { Plugin } from 'tools/dap/plugin.js';

class SourcesManager extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('SourcesManager', 'manager');
		this.jsDebugger = jsDebugger;
		this.logger.debug('Setting up SourcesManager');

		jsDebugger.on('onNewScript', ({ script, global }) => {
			if (!jsDebugger.debuggerAttached)
				return;

			this.logger.debug(`New script loaded: ${script.url}`);
			const url = script.url;
			let index = this.jsDebugger.sourcesReferences.findIndex((src) => src.path === url);
			if (index === -1)
			{
				this.jsDebugger.sourcesReferences.push({
					'path': url,
					'source': script.source
				});
				index = this.jsDebugger.sourcesReferences.length - 1;
			}

			jsDebugger.pushEvent('loadedSource', {
				'reason': 'new',
				'source': {
					'path': url,
					'sourceReference': index + 1
				}
			}, this.name);
		}, this.name);

		jsDebugger.on('onDebuggerDetached', () => {
			this.logger.debug('Debugger detached');
			this.jsDebugger.sourcesReferences = [];
		}, this.name);

		jsDebugger.on('onDebuggerAttached', () => {
			this.logger.debug('Debugger attached');
			this.jsDebugger.sourcesReferences = [];
			this.jsDebugger.instance.findSources().forEach((source) => {
				const url = source.url;
				if (this.jsDebugger.sourcesReferences.some((src) => src.path === url))
					return;
				this.jsDebugger.sourcesReferences.push({
					'path': url,
					'source': source,
				});
			});
		}, this.name);

		dapHandler.registerCommand('loadedSources', (req) => {
			if (!jsDebugger.debuggerAttached)
			{
				this.logger.error('Debugger not attached, cannot handle loadedSources command');
				return dapHandler.errorResponse(req, 'Debugger not attached');
			}

			this.logger.info('Handling loadedSources command');
			const sources = this.jsDebugger.sourcesReferences.map((src, index) => ({
				'sourceReference': index + 1,
				'path': src.path,
				'origin': 'Pyrogenesis'
			}));
			return dapHandler.successResponse(req, { 'sources': sources });
		});

		dapHandler.registerCommand('source', (req) => {
			if (!jsDebugger.debuggerAttached)
			{
				this.logger.error('Debugger not attached, cannot handle source command');
				return dapHandler.errorResponse(req, 'Debugger not attached');
			}

			const sourceRef = req.arguments.sourceReference;
			if (sourceRef < 1 || sourceRef > this.jsDebugger.sourcesReferences.length)
			{
				this.logger.error(`Invalid source reference: ${sourceRef}`);
				return dapHandler.errorResponse(req, 'Invalid source reference');
			}

			const source = this.jsDebugger.sourcesReferences[sourceRef - 1];
			this.logger.info(`Handling source command for reference: ${sourceRef}`);
			return dapHandler.successResponse(req, {
				'content': source.source.text
			});
		});
	}
}

export default SourcesManager;
