import { logger } from 'tools/dap/logger.js';

export class DapProtocolHandler {
	constructor(jsDebugger) {
		this.commands = {};
		this.jsDebugger = jsDebugger;
		this.logger = logger.getLogger("DAPProtocolHandler");
	}

	registerCommand(name, fn) {
		this.logger.info(`Registering command: ${name}`);
		this.commands[name] = fn;
	}

	handleRequest(req) {
		if (req.type !== 'request' || !req.command)
		{
			this.logger.error(`Invalid request: ${JSON.stringify(req)}`);
			return this.errorResponse(req, 'Invalid request format');
		}

		const handler = this.commands[req.command];
		if (!handler)
			return this.errorResponse(req, `Unknown command ${req.command}`);

		try
		{
			this.logger.info(`Handling command: ${req.command}`);
			return handler(req);
		}
		catch (error)
		{
			this.logger.error(`Error handling command ${req.command}:`, error);
			this.logger.error(uneval(error.stack));
			return this.errorResponse(req, error.message || 'An error occurred while processing the request');
		}
	}

	successResponse(req, result) {
		this.logger.info(`Response to ${req.command}`, result);
		const response = {
			'type': 'response',
			'request_seq': req.seq,
			'success': true,
			'command': req.command,
			'body': result
		};
		return response;
	}

	errorResponse(req, error) {
		this.logger.error(`Error in ${req.command}: ${error}`);
		const response = {
			'type': 'response',
			'request_seq': req.seq,
			'success': false,
			'command': req.command,
			'body': {
				'error': error
			}
		};
		return response;
	}
}
