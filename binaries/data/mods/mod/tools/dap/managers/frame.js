import { Plugin } from 'tools/dap/plugin.js';

class FrameManager extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('FrameManager', 'manager');

		this.logger.debug('Setting up FrameManager');
		this.jsDebugger = jsDebugger;

		jsDebugger.registerHookName('onContinue', this.name);
		jsDebugger.registerHookName('onNext', this.name);
		jsDebugger.registerHookName('onStepIn', this.name);
		jsDebugger.registerHookName('onStepOut', this.name);

		jsDebugger.on('onDebuggerDetached', () => {
			this.logger.debug('Debugger detached');
			let frame = jsDebugger.currentFrame;
			while (frame)
			{
				this.cleanFrameDebugger(frame);
				frame = frame.onStack && !frame.terminated ? frame.older : null;
			}
			this.breakpoints = [];
			jsDebugger.currentFrame = undefined;
		}, this.name);

		jsDebugger.on('onDebuggerStatement', (frame) => {
			jsDebugger.stopInframe(frame, () => {
				this.logger.debug(`Paused on debugger statement in frame: ${frame.script.url}`);
				jsDebugger.pushEvent('stopped', {
					'reason': 'debugger',
					'threadId': 1,
					'text': "Paused on debugger statement"
				}, this.name);
			});
		}, this.name);

		jsDebugger.on('onEnterFrame', (frame) => {
			if (!frame || !frame.older || !frame.older.stepIn || frame.onStep !== undefined)
				return;

			this.logger.debug(`Stepping in frame: ${frame.script.url}`);
			this.hookFrameDebugger(frame, "stepIn", "Paused on stepIn");
		}, this.name);

		dapHandler.registerCommand('stackTrace', (req) => {
			this.logger.debug('Handling stackTrace command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			const stackFrames = [];
			let frame = jsDebugger.currentFrame;

			while (frame)
			{
				const location = frame.script.getOffsetMetadata(frame.offset);
				const sourceReferenceIndex = jsDebugger.sourcesReferences.findIndex((src) => src.path === frame.script.url);
				stackFrames.push({
					'id': stackFrames.length + 1,
					'name': frame.script.displayName || this.extractScriptName(frame.script.url),
					'source': { 'path': frame.script.url, 'sourceReference': sourceReferenceIndex + 1 },
					'line': location.lineNumber + (1 - frame.script.source.startLine),
					'column': location.columnNumber
				});
				frame = frame.onStack && !frame.terminated ? frame.older : null;
			}

			return dapHandler.successResponse(req, { 'stackFrames': stackFrames });
		});

		dapHandler.registerCommand('continue', (req) => {
			this.logger.debug('Handling continue command');
			let frame = jsDebugger.currentFrame;
			while (frame)
			{
				this.cleanFrameDebugger(frame);
				frame = frame.older;
			}
			jsDebugger.triggerHook('onContinue', jsDebugger.currentFrame);
			Engine.EndWaitingForMessage();
			return dapHandler.successResponse(req, { 'allThreadsContinued': true });
		});

		dapHandler.registerCommand('next', (req) => {
			this.logger.debug('Handling next command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			this.hookFrameDebugger(jsDebugger.currentFrame, "next", "Paused on next");
			jsDebugger.currentFrame.stepIn = false;
			jsDebugger.currentFrame.stepOut = true;
			jsDebugger.currentFrame.stepOver = true;

			jsDebugger.triggerHook('onNext', jsDebugger.currentFrame);

			Engine.EndWaitingForMessage();
			return dapHandler.successResponse(req, undefined);
		});

		dapHandler.registerCommand('stepIn', (req) => {
			this.logger.debug('Handling stepIn command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			this.hookFrameDebugger(jsDebugger.currentFrame, "stepIn", "Paused on stepIn");
			jsDebugger.currentFrame.stepIn = true;
			jsDebugger.currentFrame.stepOut = false;
			jsDebugger.currentFrame.stepOver = false;

			jsDebugger.triggerHook('onStepIn', jsDebugger.currentFrame);

			Engine.EndWaitingForMessage();
			return dapHandler.successResponse(req, undefined);
		});

		dapHandler.registerCommand('stepOut', (req) => {
			this.logger.debug('Handling stepOut command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			jsDebugger.currentFrame.stepIn = false;
			jsDebugger.currentFrame.stepOut = true;
			jsDebugger.currentFrame.stepOver = false;
			this.hookFrameDebugger(jsDebugger.currentFrame, "stepOut", "Paused on stepOut");

			jsDebugger.triggerHook('onStepOut', jsDebugger.currentFrame);

			Engine.EndWaitingForMessage();
			return dapHandler.successResponse(req, undefined);
		});
	}

	extractScriptName(url) {
		if (!url)
			return "[No Name]";
		const parts = url.split('\\');
		return parts[parts.length - 1] || "[No Name]";
	}

	hookFrameDebugger(frame, reason, msg) {
		if (!frame)
			return;

		const that = this;
		if (frame.onStep === undefined)
		{
			frame.onStep = function() {
				if (this.stepOut === true && this.stepOver !== true)
					return;
				const currentLocation = this.script.getOffsetLocation(frame.offset);
				if (this.currentLocation?.lineNumber === currentLocation.lineNumber)
					return;

				that.jsDebugger.stopInframe(this, () => {
					that.jsDebugger.pushEvent('stopped', {
						'reason': reason,
						'threadId': 1,
						'text': msg
					}, that.name);
				});
				that.logger.debug("Client continue from step");
			};
		}

		if (frame.onPop === undefined)
		{
			frame.onPop = function() {
				if (this.stepIn || this.stepOut)
					that.hookFrameDebugger(this.older, reason, msg);
				that.cleanFrameDebugger(this);
			};
		}
	}

	cleanFrameDebugger(frame) {
		if (!frame)
			return;

		if (frame.onStep)
			frame.onStep = undefined;

		if (frame.onPop)
			frame.onPop = undefined;

		frame.stepIn = undefined;
		frame.stepOut = undefined;
		frame.stepOver = undefined;

		if (!frame.onStack && frame.terminated)
			return;
		this.logger.debug(`Cleaned frame: ${frame.script.url}`);
	}
}
export default FrameManager;
