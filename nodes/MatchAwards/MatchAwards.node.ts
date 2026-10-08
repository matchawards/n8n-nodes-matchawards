import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IN8nHttpFullResponse,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';
import { version } from '../../package.json';

// Read-only client of the public MatchAwards API. Behaviour, filters, validation and error wording follow the
// matchawards-mcp server (src/matchawards_mcp/server.py): same API, same paging, same messages.

const USER_AGENT = `n8n-nodes-matchawards/${version} (+https://github.com/matchawards/n8n-nodes-matchawards)`;
const DEFAULT_BASE = 'https://matchawards.com';
const SEARCH_PATH = '/api/public/v1/opportunities';
const TIMEOUT_MS = 10_000; // the API answers within about 2 s by design
const MAX_PAGES = 3; // API requests one search may make while filling Limit

const NAICS_RE = /^\s*\d{6}(\s*,\s*\d{6}){0,9}\s*$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type Resource = 'contract' | 'grant' | 'job';
type Ctx = IExecuteFunctions;

// --- UI ------------------------------------------------------------------------------------------------------

const searchOf = (resource: Resource) => ({ show: { resource: [resource], operation: ['search'] } });

const NAICS_DESC =
	"Up to 10 six-digit NAICS codes, comma-separated, e.g. '236220' or '541511,541512'. Unknown codes are ignored.";

const f = {
	state: {
		displayName: 'State',
		name: 'state',
		type: 'string',
		default: '',
		placeholder: 'VA',
		description:
			"Two-letter US state code, e.g. 'VA'. Many federal notices have no state, so this filter skips them.",
	},
	keyword: {
		displayName: 'Keyword',
		name: 'keyword',
		type: 'string',
		default: '',
		description: '2 to 100 characters matched against the title only',
	},
	setAside: {
		displayName: 'Set-Aside',
		name: 'setAside',
		type: 'string',
		default: '',
		placeholder: 'SBA',
		description: "Set-aside code, e.g. 'SBA' or 'SDVOSBC'. Federal contracts only.",
	},
	postedWithinDays: {
		displayName: 'Posted Within Days',
		name: 'postedWithinDays',
		type: 'number',
		default: 180,
		typeOptions: { minValue: 1, maxValue: 180 },
		description: 'Only items posted in the last N days, 1 to 180 (default 180)',
	},
	jobsPostedWithinDays: {
		displayName: 'Posted Within Days',
		name: 'postedWithinDays',
		type: 'number',
		default: 30,
		typeOptions: { minValue: 1, maxValue: 30 },
		description: 'Only jobs posted in the last N days, 1 to 30',
	},
	includeClosed: {
		displayName: 'Include Closed',
		name: 'includeClosed',
		type: 'boolean',
		default: false,
		description:
			'Whether to include closed items. Off (the default): only items with a response deadline of today or later, US Eastern; an item with no deadline counts as closed.',
	},
	cursor: {
		displayName: 'Cursor',
		name: 'cursor',
		type: 'string',
		default: '',
		description:
			'next_cursor from the previous response (turn on Include Paging Info to see it). Pass it with the same filters to get the next page.',
	},
} satisfies Record<string, INodeProperties>;

const operation = (resource: Resource, plural: string, what: string): INodeProperties => ({
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: [resource] } },
	options: [
		{
			name: 'Search',
			value: 'search',
			description: what,
			action: `Search ${plural}`,
		},
		{
			name: 'Get',
			value: 'get',
			description:
				'Get the full record of one opportunity by its id from a search result: the search row plus description (up to 2000 characters) and contacts [{name, title}]',
			action: `Get a ${resource}`,
		},
	],
	default: 'search',
});

const filters = (resource: Resource, fields: INodeProperties[]): INodeProperties => ({
	displayName: 'Filters',
	name: 'filters',
	type: 'collection',
	placeholder: 'Add Filter',
	default: {},
	displayOptions: searchOf(resource),
	options: fields,
});

const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Contract', value: 'contract' },
			{ name: 'Grant', value: 'grant' },
			{ name: 'Job', value: 'job' },
		],
		default: 'contract',
	},
	operation(
		'contract',
		'contracts',
		'Search US federal and state government contract opportunities (bids, RFPs, solicitations)',
	),
	operation('grant', 'grants', 'Search US federal grant and funding opportunities'),
	operation('job', 'jobs', 'Search job postings from the last 30 days listed on MatchAwards'),
	{
		displayName: 'ID',
		name: 'id',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { operation: ['get'] } },
		description: 'The id field of a search result',
	},
	{
		displayName: 'NAICS',
		name: 'naics',
		type: 'string',
		default: '',
		placeholder: '541511,541512',
		displayOptions: { show: { operation: ['search'] } },
		description: NAICS_DESC,
	},
	{
		displayName: 'Level',
		name: 'level',
		type: 'options',
		options: [
			{ name: 'Both', value: 'both', description: 'Federal and state contracts' },
			{ name: 'Federal', value: 'federal' },
			{ name: 'State', value: 'state' },
		],
		default: 'both',
		displayOptions: searchOf('contract'),
		description: 'Narrow to federal or to state contracts',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 20,
		typeOptions: { minValue: 1, maxValue: 50 },
		displayOptions: { show: { operation: ['search'] } },
		description: 'Max number of results to return, 1 to 50',
	},
	filters('contract', [f.state, f.keyword, f.setAside, f.postedWithinDays, f.includeClosed, f.cursor]),
	filters('grant', [
		f.keyword,
		f.postedWithinDays,
		{
			...f.includeClosed,
			description:
				'Whether to include closed grants. Off (the default): open grants of any age; a grant with no deadline counts as closed.',
		},
		f.cursor,
	]),
	filters('job', [f.state, f.keyword, f.jobsPostedWithinDays, f.cursor]),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Include Paging Info',
				name: 'includePagingInfo',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/operation': ['search'] } },
				description:
					'Whether to output one item {as_of, results, has_more, next_cursor} instead of one item per result',
			},
			{
				displayName: 'API Base URL',
				name: 'apiBaseUrl',
				type: 'string',
				default: DEFAULT_BASE,
				description: 'Override for testing, e.g. https://staging.matchawards.com',
			},
		],
	},
];

// --- API -----------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is IDataObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Turn an API error response ({error, parameter?} JSON) into advice a user can act on. Same as the MCP's. */
function errorMessage(r: IN8nHttpFullResponse): string {
	const raw = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
	const body = isObject(r.body) ? r.body : {};
	const error = body.message || body.error || raw.trim().slice(0, 200) || r.statusMessage;
	if (r.statusCode === 429) {
		const wait = r.headers['retry-after'] || body.retry_after || 60;
		return (
			'MatchAwards rate limit reached (per IP: 60 requests per minute, 20 per 5 seconds). ' +
			`Wait ${wait} seconds, then retry.`
		);
	}
	if (body.error === 'grants_unavailable') {
		return 'Grant search is temporarily unavailable on MatchAwards. Try again later; contracts and jobs still work.';
	}
	if (r.statusCode >= 500) {
		return `MatchAwards server error (HTTP ${r.statusCode}). It is temporary; retry in a minute.`;
	}
	if (r.statusCode === 400 && body.parameter) {
		return `MatchAwards rejected the parameter '${body.parameter}': ${error}. Fix it and call again.`;
	}
	if (r.statusCode === 404) return `Not found on MatchAwards (${error}). Use an id from a search result.`;
	return `MatchAwards rejected the request (HTTP ${r.statusCode}): ${error}`;
}

/** GET one API path; turn every failure into a node error with the MCP's wording. */
async function apiGet(ctx: Ctx, i: number, base: string, path: string, params: IDataObject = {}) {
	const qs = Object.fromEntries(
		Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
	);
	let r: IN8nHttpFullResponse;
	try {
		r = (await ctx.helpers.httpRequest({
			method: 'GET',
			url: base + path,
			qs,
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
			timeout: TIMEOUT_MS,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as IN8nHttpFullResponse;
	} catch (e) {
		const code: string = e?.code ?? '';
		const message =
			code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(e?.message ?? '')
				? `MatchAwards did not answer within ${TIMEOUT_MS / 1000} seconds. Retry once; if it fails again, ` +
					'narrow the search (fewer NAICS codes, a shorter Posted Within Days) or try later.'
				: `Could not reach MatchAwards at ${base} (${code || e?.name || 'Error'}). Check the network and retry later.`;
		const err = new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
		err.message = message; // n8n swaps a message naming ECONNREFUSED etc. for generic text; keep ours
		throw err;
	}
	let body = r.body;
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			// not JSON: errorMessage() falls back to the raw text
		}
	}
	if (r.statusCode >= 400) {
		throw new NodeApiError(ctx.getNode(), (isObject(body) ? body : {}) as JsonObject, {
			message: errorMessage({ ...r, body }),
			httpCode: String(r.statusCode),
			itemIndex: i,
		});
	}
	if (!isObject(body)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`MatchAwards returned an unexpected response (HTTP ${r.statusCode}, not a JSON object). Retry later.`,
			{ itemIndex: i },
		);
	}
	return body;
}

/** Collect up to `limit` unique rows. A sparse filter can return a short page with has_more, so
 * follow next_cursor with the same filters, for at most MAX_PAGES requests. */
async function search(ctx: Ctx, i: number, base: string, params: IDataObject, limit: number) {
	const rows = new Map<string, IDataObject>();
	let page: IDataObject | undefined;
	let asOf: unknown;
	let warning: string | undefined;
	for (let n = 0; n < MAX_PAGES; n++) {
		let next: IDataObject;
		let results: unknown;
		try {
			// Ask only for what is still missing, so no row is read past the cursor and then dropped.
			next = await apiGet(ctx, i, base, SEARCH_PATH, { ...params, limit: limit - rows.size });
			results = next.results;
			if (!Array.isArray(results) || !results.every(isObject)) {
				throw new NodeOperationError(
					ctx.getNode(),
					'MatchAwards returned an unexpected API response (results is not a list of objects).',
					{ itemIndex: i },
				);
			}
		} catch (e) {
			if (!page) throw e; // first page: nothing to return, so the call fails
			// Follow-up page: keep what we have; the last good page's next_cursor still points at the rest.
			warning = `Stopped after ${rows.size} rows: ${e.message} More results may exist; call again with next_cursor.`;
			break;
		}
		page = next;
		asOf = asOf || page.as_of;
		for (const row of results as IDataObject[]) {
			const key = String(row.id);
			if (!rows.has(key)) rows.set(key, row);
		}
		if (rows.size >= limit || !(page.has_more && page.next_cursor)) break;
		params = { ...params, cursor: page.next_cursor };
	}
	const out: IDataObject = {
		as_of: asOf ?? null,
		results: [...rows.values()],
		has_more: Boolean(page!.has_more),
		next_cursor: page!.next_cursor ?? null,
	};
	return warning ? { ...out, warning } : out;
}

// --- Parameters ----------------------------------------------------------------------------------------------

function searchParams(ctx: Ctx, i: number, resource: Resource): IDataObject {
	const fail = (message: string) => new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
	const flt = ctx.getNodeParameter('filters', i, {}) as IDataObject;
	const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
	const days = (v: unknown, max: number) => {
		if (v === undefined || v === null || v === '') return undefined;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 1 || n > max) throw fail(`Posted Within Days must be a whole number from 1 to ${max}.`);
		return n;
	};

	const naics = text(ctx.getNodeParameter('naics', i, ''));
	if (naics && !NAICS_RE.test(naics)) {
		throw fail("NAICS must be up to 10 six-digit codes, comma-separated, e.g. '236220' or '541511,541512'.");
	}
	const state = text(flt.state);
	if (state && !STATE_RE.test(state)) throw fail("State must be a two-letter US state code, e.g. 'VA'.");
	const keyword = text(flt.keyword);
	if (keyword && (keyword.length < 2 || keyword.length > 100)) throw fail('Keyword must be 2 to 100 characters.');

	const common: IDataObject = {
		naics: naics && naics.split(',').map((c) => c.trim()).join(','),
		q: keyword,
		cursor: text(flt.cursor),
	};
	const open = flt.includeClosed ? false : undefined; // unset = the API default, open only
	if (resource === 'contract') {
		const level = ctx.getNodeParameter('level', i, 'both') as string;
		return {
			...common,
			type: level === 'federal' || level === 'state' ? level : 'contract',
			state: state.toUpperCase(),
			set_aside: text(flt.setAside),
			posted_within_days: days(flt.postedWithinDays, 180),
			open,
		};
	}
	if (resource === 'grant') {
		return { ...common, type: 'grant', posted_within_days: days(flt.postedWithinDays, 180), open };
	}
	return { ...common, type: 'job', state: state.toUpperCase(), posted_within_days: days(flt.postedWithinDays, 30) ?? 30 };
}

// --- Node ----------------------------------------------------------------------------------------------------

export class MatchAwards implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MatchAwards',
		name: 'matchAwards',
		icon: 'file:matchawards.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Search US government contract opportunities (federal and state), grants and jobs from matchawards.com. Read-only.',
		defaults: { name: 'MatchAwards' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as Resource;
				const op = this.getNodeParameter('operation', i) as string;
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				const base = (String(options.apiBaseUrl || '').trim() || DEFAULT_BASE).replace(/\/+$/, '');

				if (op === 'get') {
					const id = String(this.getNodeParameter('id', i)).trim(); // ids exceed 2^53: always strings
					if (!ID_RE.test(id)) {
						throw new NodeOperationError(
							this.getNode(),
							"ID must be the id field of a search result (letters, digits, '_' or '-', up to 128 characters).",
							{ itemIndex: i },
						);
					}
					const data = await apiGet(this, i, base, `${SEARCH_PATH}/${id}`);
					if (!isObject(data.result)) {
						throw new NodeOperationError(
							this.getNode(),
							'MatchAwards returned an unexpected API response (no result object).',
							{ itemIndex: i },
						);
					}
					out.push({ json: { ...data.result, as_of: data.as_of }, pairedItem: { item: i } });
					continue;
				}

				const limit = Number(this.getNodeParameter('limit', i, 20));
				if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
					throw new NodeOperationError(this.getNode(), 'Limit must be a whole number from 1 to 50.', {
						itemIndex: i,
					});
				}
				const page = await search(this, i, base, searchParams(this, i, resource), limit);
				if (options.includePagingInfo) {
					out.push({ json: page, pairedItem: { item: i } });
					continue;
				}
				if (page.warning) this.addExecutionHints({ message: String(page.warning), type: 'warning' });
				for (const row of page.results as IDataObject[]) out.push({ json: row, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: error.message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}
		return [out];
	}
}
