import { logger } from 'tools/dap/logger.js';

export class JsDebugger {
	constructor() {
		this.debugger = new Debugger();
		this.logger = logger.getLogger("SpiderDebugger");
		this.events = [];
		this.sourcesReferences = [];
		this.currentFrame = null;
		this.hooks = {
			'onDebuggerAttached': [],
			'onDebuggerDetached': [],
			'onNewGlobalObject': [],
			'onDebuggerStatement': [],
			'onNewScript': [],
			'onEnterFrame': [],
			'onUncaughtException': [],
			'onStopInFrame': [],
			'onRsumeInFrame': [],
		};

		this.debugger.uncaughtExceptionHook = (e) => {
			this._runHooks('onUncaughtException', e);
		};

		this.debugger.onNewGlobalObject = (global) => {
			this._runHooks('onNewGlobalObject', global);
		};

		this.debugger.onDebuggerStatement = (frame) => {
			this._runHooks('onDebuggerStatement', frame);
		};

		this.debugger.onNewScript = (script, global) => {
			this._runHooks('onNewScript', { script, global });
		};

		this.debugger.onEnterFrame = (frame) => {
			this._runHooks('onEnterFrame', frame);
		};

		this.debuggerAttached = false;
	}

	_runHooks(event, data) {
		this.logger.trace(`Running hook for ${event}`);
		for (const hookInfo of this.hooks[event])
		{
			this.logger.trace(`Running hook for ${hookInfo.source}-${event}`);
			if (typeof hookInfo.callback !== 'function')
			{
				this.logger.warn(`Hook for ${event} is not a function: ${hook.source}`);
				continue;
			}

			try {
				hookInfo.callback(data);
			} catch (e) {
				this.logger.error(`Error in hook for ${hookInfo.source}-${event}: ${e.message}`);
				this.logger.error(uneval(e.stack));
			}
		}
	}

	on(event, callback, source) {
		if (!event || typeof event !== 'string')
		{
			this.logger.warn('Invalid event name');
			return;
		}

		if (!this.hooks[event])
		{
			this.logger.warn(`No hooks registered for event: ${event}`);
			return;
		}

		if (!source || typeof source !== 'string')
		{
			this.logger.warn(`Invalid source name for event ${event}`);
			return;
		}
		if (typeof callback !== 'function')
		{
			this.logger.warn(`Callback for event ${source}:${event} is not a function`);
			return;
		}

		this.hooks[event].push({ callback, source });
		this.logger.debug(`Hook added for event: ${event}`);
	}

	get instance() {
		return this.debugger;
	}

	setAttached(attached) {
		this.debuggerAttached = attached;
		if (attached)
		{
			this.logger.debug("Debugger attached");
			this._runHooks('onDebuggerAttached', {});
		}
		else
		{
			this.logger.debug("Debugger detached");
			this._runHooks('onDebuggerDetached', {});
		}
	}

	pushEvent(eventName, eventData, source) {
		if (!eventName || typeof eventName !== 'string')
		{
			this.logger.warn('Invalid event name');
			return;
		}
		if (source && typeof source !== 'string')
		{
			this.logger.warn('Invalid source name');
			return;
		}

		this.logger.debug(`Pushing event: ${source}-${eventName}`);
		this.events.push({
			'type': 'event',
			'event': eventName,
			'body': eventData
		});
	}

	stopInframe(frame, onHandler) {
		if (!frame || !(frame instanceof Debugger.Frame))
		{
			this.logger.error('Invalid frame provided to stopInframe');
			return;
		}

		this.currentFrame = frame;
		frame.currentLocation = frame.script.getOffsetLocation(frame.offset);
		this.logger.debug(`Stop at ${frame.script.url}:${frame.currentLocation.lineNumber}:${frame.currentLocation.columnNumber}`);
		this.logger.debug(`Frame type: ${frame.type}`);

		if (onHandler && typeof onHandler === 'function')
			onHandler();

		this._runHooks('onStopInFrame', frame);
		Engine.WaitForMessage();
		this._runHooks('onRsumeInFrame', frame);

		this.logger.debug("Client continue");
	}

	registerHookName(event, source) {
		if (!event || typeof event !== 'string')
		{
			this.logger.warn('Invalid event name');
			return;
		}

		if (!source || typeof source !== 'string')
		{
			this.logger.warn(`Invalid source name for ${event}`);
			return;
		}

		if (this.hooks[event])
		{
			this.logger.warn(`Hooks already registered for event: ${event}`);
			return;
		}

		this.hooks[event] = [];
		this.logger.debug(`Hook registered for event: ${event} from source: ${source}`);
	}

	triggerHook(event, data) {
		if (!event || typeof event !== 'string')
		{
			this.logger.warn('Invalid event name');
			return;
		}

		this._runHooks(event, data);
	}
}
