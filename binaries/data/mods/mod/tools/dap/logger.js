class Logger {
	levels = ['trace', 'debug', 'info', 'warn', 'error'];
	// Default = 'info'.
	levelIndex = 2;

	setLevel(level) {
		const index = this.levels.indexOf(level);
		if (index === -1)
		{
			throw new Error(`Invalid log level: ${level}`);
		}
		this.levelIndex = index;
	}

	constructor() {
		this.levels.forEach((level, index) => {
			this[level] = (...args) => {
				if (index < this.levelIndex)
					return;

				if (level === 'error')
					error(`${args.join(' ')}`);
				else if (level === 'warn')
					warn(`${args.join(' ')}`);
				else
					log(`[${level.toUpperCase()}] ${args.join(' ')}`);
			};
		});
	}

	getLevel() {
		return this.levels[this.levelIndex];
	}

	getLogger(className) {
		const scopedLogger = {};
		this.levels.forEach((level) => {
			scopedLogger[level] = (msg) => {
				this[level](`[${className}]`, msg);
			};
		});
		return scopedLogger;
	}
}

export const logger = new Logger();
