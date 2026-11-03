import { Plugin } from 'tools/dap/plugin.js';

class DapCommands extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('DapCommonCommand', 'command');

		jsDebugger.registerHookName('onInitialize', this.name);
		dapHandler.registerCommand('initialize', (req) => {
			this.logger.info('Handling initialize command');
			return dapHandler.successResponse(req, {
				'supportsConfigurationDoneRequest': true,
				'supportsLoadedSourcesRequest': true,
			});
		});

		dapHandler.registerCommand('disconnect', (req) => {
			this.logger.info('Handling disconnect command');
			jsDebugger.setAttached(false);
			Engine.EndWaitingForMessage();
			return dapHandler.successResponse(req, undefined);
		});

		dapHandler.registerCommand('attach', (req) => {
			this.logger.info('Handling attach command');
			jsDebugger.setAttached(true);
			jsDebugger.pushEvent('initialized', undefined, this.name);
			return dapHandler.successResponse(req, undefined);
		});

		dapHandler.registerCommand('configurationDone', (req) => {
			this.logger.info('Handling configurationDone command');
			return dapHandler.successResponse(req, undefined);
		});

		dapHandler.registerCommand('threads', (req) => {
			this.logger.info('Handling threads command');
			jsDebugger.triggerHook('onInitialize', undefined);
			return dapHandler.successResponse(req, {
				'threads': [{ 'id': 1, 'name': "Main Thread" }]
			});
		});
	}
}

export default DapCommands;
