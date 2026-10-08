// A fake IExecuteFunctions for the built node: parameters from a plain object, httpRequest injected.
const { MatchAwards } = require('../dist/nodes/MatchAwards/MatchAwards.node.js');

const node = new MatchAwards();
const defaults = Object.fromEntries(node.description.properties.map((p) => [p.name, p.default]));

async function run({ params, items = [{ json: {} }], httpRequest, continueOnFail = false }) {
	const hints = [];
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => {
			const p = Array.isArray(params) ? params[i] : params;
			return p[name] ?? fallback ?? defaults[name];
		},
		getNode: () => ({ id: '1', name: 'MatchAwards', type: 'n8n-nodes-matchawards.matchAwards', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		addExecutionHints: (...h) => hints.push(...h),
		helpers: { httpRequest },
	};
	const [out] = await node.execute.call(ctx);
	return { out, hints };
}

module.exports = { run };
