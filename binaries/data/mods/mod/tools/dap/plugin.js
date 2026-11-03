import { logger } from 'tools/dap/logger.js';

export class Plugin {
	constructor(name, type) {
		this.name = name;
		this.type = type;
		this.logger = logger.getLogger(name);
	}
}
