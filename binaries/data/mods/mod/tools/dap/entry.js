import { logger } from 'tools/dap/logger.js';
import { JsDebugger } from 'tools/dap/jsdebugger.js';
import { DapProtocolHandler } from 'tools/dap/daphandler.js';
import { plugins as managerPlugins } from 'tools/dap/managers/index.js';
import { plugins as commandPlugins } from 'tools/dap/commands/index.js';

// ===== Bootstrap System =====
// Set the logging level to 'info' for the entire system.
// TODO: Make this configurable via a settings file or command line argument.
logger.setLevel('debug');
logger.debug('Boostrapping system...');

const jsDebugger = new JsDebugger();
const dapHandler = new DapProtocolHandler(jsDebugger);

function loadPlugins(pluginClasses)
{
	for (const PluginClass of pluginClasses)
	{
		const plugin = new PluginClass(jsDebugger, dapHandler);
	}
}

logger.debug('Loading manager plugins...');
loadPlugins(managerPlugins);

logger.debug('Loading commands plugins...');
loadPlugins(commandPlugins);

// ===== Global Functions =====
export function sendEventToClient()
{
	return jsDebugger.events.shift();
}

export function handleMessage(message)
{
	return dapHandler.handleRequest(message);
}
