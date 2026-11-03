import { Plugin } from 'tools/dap/plugin.js';

class InspectorManager extends Plugin {
	constructor(jsDebugger, dapHandler) {
		super('InspectorManager', 'manager');
		this.variableReferences = [];

		this.logger.debug('Setting up InspectorManager');

		jsDebugger.on('onDebuggerDetached', () => {
			this.logger.debug('Debugger attached');
			this.variableReferences = [];
		}, this.name);

		jsDebugger.on('onContinue', () => {
			this.logger.debug('Continuing execution');
			this.variableReferences = [];
		}, this.name);

		dapHandler.registerCommand('scopes', (req) => {
			this.logger.debug('Handling scopes command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			if (!jsDebugger.currentFrame.onStack || jsDebugger.currentFrame.terminated)
			{
				this.logger.error('Current frame is not on stack or is terminated');
				return dapHandler.errorResponse(req, 'Current frame is not on stack or is terminated');
			}

			const scopes = [];
			let frameId = req.arguments.frameId;
			let frame = jsDebugger.currentFrame;
			while (frameId > 1)
			{
				frameId--;
				frame = frame.onStack && !frame.terminated ? frame.older : null;

				if (!frame)
				{
					this.logger.error(`Invalid frameId: ${req.arguments.frameId}`);
					return dapHandler.errorResponse(req, 'Invalid frameId');
				}
			}

			return dapHandler.successResponse(req, { 'scopes': this.createScopeAndVariableReferences(frame, req.arguments.frameId) });
		});

		dapHandler.registerCommand('variables', (req) => {
			this.logger.debug('Handling variables command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			const variables = this.expandVariableReference(req.arguments.variablesReference, jsDebugger.currentFrame);
			return dapHandler.successResponse(req, { 'variables': variables });
		});

		dapHandler.registerCommand('evaluate', (req) => {
			this.logger.debug('Handling evaluate command');
			if (!jsDebugger.currentFrame)
			{
				this.logger.error('No current frame available');
				return dapHandler.errorResponse(req, 'No current frame available');
			}

			const expression = req.arguments.expression;
			if (!expression)
			{
				this.logger.error('No expression provided for evaluation');
				return dapHandler.errorResponse(req, 'No expression provided for evaluation');
			}

			try
			{
				const result = jsDebugger.currentFrame.eval(expression);
				if (result.return instanceof Debugger.Object)
				{
					const described = this.describeJSObjectVariable(result.return, `eval.${expression}`, { "frameId": req.arguments.frameId }, expression);
					described.result = described.value;
					return dapHandler.successResponse(req, described);
				}
				else if (result.return !== undefined)
					return dapHandler.successResponse(req, {
						'result': JSON.stringify(result.return) || "null",
					});
				return dapHandler.successResponse(req, { 'result': JSON.stringify(result) || "null", 'variablesReference': 0 });
			}
			catch (error)
			{
				this.logger.error(`Error evaluating expression: ${error.message}`);
				return dapHandler.errorResponse(req, `Error evaluating expression: ${error.message}`);
			}
		});
	}

	createOrUpdateVariableReference(name, data) {
		let index = this.variableReferences.findIndex((ref) => ref.name === name);
		if (index === -1)
		{
			this.variableReferences.push({ name, data });
			index = this.variableReferences.length - 1;
		}
		else
			this.variableReferences[index].data = data;

		return index + 1;
	}

	createScopeAndVariableReferences(frame, frameId) {
		if (!frame || !frame.onStack || frame.terminated)
		{
			this.logger.error(`Invalid frame: ${frameId}`);
			return [];
		}

		const scopes = [];
		let environment = frame.environment;
		let depth = 0;

		while (environment !== null)
		{
			this.logger.debug(`Creating scope and variable references for environment: ${environment.type}, depth: ${depth}, frameId: ${frameId}, frameType: ${frame.type}`);

			const labelParts = [];
			const scope = {};
			scope.variablesReference = 0;

			if (environment.optimizedOut)
				labelParts.push('(Optimized Out)');

			switch (environment.type)
			{
			case 'object':
				labelParts.push('Global');
				break;
			case 'width':
				labelParts.push('With Scope');
				break;
			case 'declarative':
				if (environment.scopeKind === 'function')
					labelParts.push('Closure');
				else if (environment.scopeKind === 'function lexical')
					labelParts.push('Function Block');
				else if (environment.scopeKind)
					labelParts.push(environment.scopeKind.charAt(0).toUpperCase() + environment.scopeKind.slice(1));
				else
					labelParts.push('Declarative');
				break;
			default:
				labelParts.push(environment.type || "Unknown");
			}

			if (environment.calleeScript)
				labelParts.push(`(Script: ${environment.calleeScript.displayName || environment.calleeScript.name || 'unknown'})`);

			scope.name = labelParts.join(' ');

			const names = (typeof environment.names === "function") ? environment.names() : [];

			if (depth === 0 && frame.this instanceof Debugger.Object)
				names.unshift('this');

			scope.variablesReference = this.createOrUpdateVariableReference(`${frameId}.scope.${depth}`, {
				"values": names,
				"frameId": frameId,
			});

			scope.expensive = false;
			scopes.push(scope);

			environment = environment.parent;
			depth++;
		}

		return scopes;
	}

	describeJSObjectCallable(jsObject, varName) {
		if (!jsObject || !(jsObject instanceof Debugger.Object) || !jsObject.callable)
		{
			this.logger.error('Invalid JS Object for callable description');
			return {
				'name': varName || '(unknown)',
				'value': 'undefined',
				'variablesReference': 0
			};
		}

		const variable = {
			'name': varName,
			'variablesReference': 0,
			'presentationHint': {
				'kind': 'method',
			}
		};

		const funcName = jsObject.displayName || jsObject.name || 'anonymous';

		let funcType = 'Function';
		if (jsObject.isArrowFunction)
			funcType = 'Arrow Function';
		else if (jsObject.isClassConstructor)
			funcType = 'Class Constructor';
		else if (jsObject.isGeneratorFunction)
			funcType = 'Generator Function';
		else if (jsObject.isAsyncFunction)
			funcType = 'Async Function';
		else if (jsObject.isBoundFunction)
			funcType = 'Bound Function';

		const paramNames = (jsObject.parameterNames || []).join(', ');
		variable.type = funcType;
		variable.value = `[${funcType}] ${funcName}(${paramNames})`;

		return variable;
	}

	describeJSObjectVariable(jsObject, varRefName, varReference, varName) {
		if (!jsObject || !(jsObject instanceof Debugger.Object))
		{
			this.logger.error('Invalid JS Object for description');
			return {
				'name': varName || '(unknown)',
				'value': 'undefined',
				'variablesReference': 0
			};
		}

		if (jsObject.callable)
			return this.describeJSObjectCallable(jsObject, varName);

		const variable = {
			'name': varName,
			'variablesReference': 0,
		};

		switch (jsObject.class)
		{
		case 'Array':
		{
			const length = jsObject.getOwnPropertyDescriptor("length")?.value || 0;
			variable.value = `[Array] (${length})`;
			break;
		}
		case 'Date':
		{
			const str = jsObject.unsafeDereference().toString();
			variable.value = `[Date] ${str}`;
			break;
		}
		case 'RegExp':
		{
			const str = jsObject.unsafeDereference().toString();
			variable.value = `[RegExp] ${str}`;
			break;
		}
		case 'Map':
		case 'Set':
			variable.value = `[${jsObject.class}] (${jsObject.getOwnPropertyNames().length})`;
			break;
		case 'String':
		case 'Number':
		case 'Boolean':
		{
			const val = jsObject.unsafeDereference().valueOf();
			variable.value = `[${jsObject.class}] ${val}`;
			break;
		}
		default:
		{
			let label = jsObject.displayName || jsObject.class;

			if (jsObject.isProxy)
				label = `[Proxy ${label}]`;
			else if (jsObject.isPromise)
				label = `[Promise ${label}]`;
			else if (!jsObject.unsafeDereference)
				label = `[Opaque ${label}]`;
			else if (jsObject.proto)
			{
				const proto = jsObject.proto.displayName || jsObject.proto.class || 'unknown';
				label = `[${label} (Prototype: ${proto})]`;
			}
			else
				label = `[${label}]`;

			variable.value = label;
		}
		}

		const objectProperties = jsObject.getOwnPropertyNames();
		if (objectProperties.length === 0)
			return variable;

		variable.variablesReference = this.createOrUpdateVariableReference(varRefName, {
			'values': objectProperties,
			'jsObject': jsObject,
			'frameId': varReference.frameId
		});

		return variable;
	}

	expandVariableReference(variableReferenceIndex, frame) {
		if (variableReferenceIndex === 0 || this.variableReferences.length < variableReferenceIndex - 1)
		{
			this.logger.warn(`Invalid variable reference index: ${variableReferenceIndex}`);
			return [];
		}

		const varReferenceRef = this.variableReferences[variableReferenceIndex - 1];
		const varReference = varReferenceRef.data;
		const variables = [];

		this.logger.debug(`Expanding variable reference ${variableReferenceIndex}: ${uneval(varReferenceRef)}`);

		let frameId = varReference.frameId;
		while (frameId > 1)
		{
			frame = frame.onStack && !frame.terminated ? frame.older : null;

			if (!frame)
			{
				this.logger.error(`Invalid frameId: ${req.arguments.frameId}`);
				return dapHandler.errorResponse(req, 'Invalid frameId');
			}
			frameId--;
		}

		for (const varName of varReference.values)
		{
			this.logger.debug(`Expanding variable: ${varName}`);
			let value;
			if (varReference.jsObject)
				value = varReference.jsObject.getOwnPropertyDescriptor(varName)?.value;
			else if (varName === 'this' && frame.this instanceof Debugger.Object)
				value = frame.this;
			else
			{
				const valueEnv = frame.environment.find(varName);
				if (valueEnv === null)
				{
					this.logger.warn(`Could not find variable ${varName}`);
					continue;
				}

				if (valueEnv.type === 'object' || valueEnv.type === 'with')
					value = valueEnv.object.getOwnPropertyDescriptor(varName)?.value;
				else
					value = valueEnv.getVariable(varName);
			}

			if (value instanceof Debugger.Object)
			{
				variables.push(this.describeJSObjectVariable(value, `${varReferenceRef.name}.${varName}`, varReference, varName));
				continue;
			}

			variables.push({
				'name': varName,
				'variablesReference': 0,
				'value': JSON.stringify(value) || "null"
			});
		}

		return variables;
	}
}

export default InspectorManager;
