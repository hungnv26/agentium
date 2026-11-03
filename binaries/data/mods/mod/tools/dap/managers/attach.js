import { Plugin } from 'tools/dap/plugin.js';

class AttachManager extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('AttachManager', 'manager');

		this.logger.debug('Setting up AttachManager');
		jsDebugger.on('onDebuggerAttached', () => {
			this.logger.debug('Debugger attached');
			jsDebugger.instance.addAllGlobalsAsDebuggees();
		}, this.name);

		jsDebugger.on('onDebuggerDetached', () => {
			this.logger.debug('Debugger detached');
			jsDebugger.instance.removeAllDebuggees();
		}, this.name);

		jsDebugger.on('onNewGlobalObject', (global) => {
			if (!jsDebugger.debuggerAttached)
				return;

			this.logger.debug(`Added global object as debuggee`);
			jsDebugger.instance.addDebuggee(global);
		}, this.name);

		jsDebugger.on('onUncaughtException', (e) => {
			this.logger.error(`Uncaught exception: ${e}`);
		}, this.name);
	}
}

export default AttachManager;
