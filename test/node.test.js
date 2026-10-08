const { test } = require('node:test');
const assert = require('node:assert/strict');
const { version } = require('../package.json');
const { run } = require('./harness');

const BASE = 'https://matchawards.com/api/public/v1/opportunities';
const row = (id) => ({ id, type: 'federal', title: `t${id}`, url: `https://matchawards.com/opp/${id}` });
const page = (ids, extra = {}) => ({ statusCode: 200, headers: {}, body: { as_of: 'A', results: ids.map(row), has_more: false, next_cursor: null, ...extra } });

/** httpRequest mock: answers from the queue in order (an Error is thrown), records every call. */
function mock(...responses) {
	const calls = [];
	const fn = async (opts) => {
		calls.push(opts);
		const r = responses.length > 1 ? responses.shift() : responses[0];
		if (r instanceof Error) throw r;
		return { statusMessage: '', headers: {}, ...r };
	};
	fn.calls = calls;
	return fn;
}

const search = (resource, extra = {}) => ({ resource, operation: 'search', ...extra });
const get = (id, extra = {}) => ({ resource: 'contract', operation: 'get', id, ...extra });

async function fails(params, http, pattern) {
	await assert.rejects(run({ params, httpRequest: http }), (e) => {
		assert.match(e.message, pattern);
		return true;
	});
}

// --- parameter mapping ----------------------------------------------------------------------------------------

test('contract search maps every filter and emits one item per row', async () => {
	const http = mock(page(['1', '2']));
	const { out } = await run({
		httpRequest: http,
		params: search('contract', {
			naics: ' 541511 , 541512 ',
			limit: 5,
			filters: { state: 'va', keyword: 'roof', setAside: 'SBA', postedWithinDays: 7, includeClosed: true, cursor: 'c0' },
		}),
	});
	assert.equal(http.calls.length, 1);
	const c = http.calls[0];
	assert.equal(c.method, 'GET');
	assert.equal(c.url, BASE);
	assert.equal(c.timeout, 10000);
	assert.deepEqual(c.qs, {
		naics: '541511,541512', q: 'roof', cursor: 'c0', type: 'contract', state: 'VA', set_aside: 'SBA',
		posted_within_days: 7, open: false, limit: 5,
	});
	assert.deepEqual(out.map((x) => x.json), [row('1'), row('2')]);
	assert.deepEqual(out.map((x) => x.pairedItem), [{ item: 0 }, { item: 0 }]);
});

test('contract Level maps both -> contract, federal, state', async () => {
	for (const [level, type] of [['both', 'contract'], ['federal', 'federal'], ['state', 'state']]) {
		const http = mock(page([]));
		await run({ httpRequest: http, params: search('contract', { level }) });
		assert.equal(http.calls[0].qs.type, type);
	}
});

test('unset and empty filters are not sent; Limit defaults to 20', async () => {
	const http = mock(page([]));
	await run({ httpRequest: http, params: search('contract', { naics: '', filters: { state: '', keyword: '  ', cursor: '' } }) });
	assert.deepEqual(http.calls[0].qs, { type: 'contract', limit: 20 });
});

test('grant search: no state, open only when Include Closed', async () => {
	const http = mock(page([]));
	await run({
		httpRequest: http,
		params: search('grant', { naics: '541715', filters: { keyword: 'broadband', postedWithinDays: 90, includeClosed: true, state: 'VA' } }),
	});
	assert.deepEqual(http.calls[0].qs, { naics: '541715', q: 'broadband', type: 'grant', posted_within_days: 90, open: false, limit: 20 });
});

test('job search: posted_within_days defaults to 30, no open filter', async () => {
	const http = mock(page([]));
	await run({ httpRequest: http, params: search('job', { filters: { state: 'tx', keyword: 'electrician', includeClosed: true } }) });
	assert.deepEqual(http.calls[0].qs, { q: 'electrician', type: 'job', state: 'TX', posted_within_days: 30, limit: 20 });
	const http2 = mock(page([]));
	await run({ httpRequest: http2, params: search('job', { filters: { postedWithinDays: 7 } }) });
	assert.equal(http2.calls[0].qs.posted_within_days, 7);
});

test('User-Agent is n8n-nodes-matchawards/<package version>', async () => {
	const http = mock(page([]));
	await run({ httpRequest: http, params: search('contract') });
	assert.equal(http.calls[0].headers['User-Agent'], `n8n-nodes-matchawards/${version} (+https://github.com/matchawards/n8n-nodes-matchawards)`);
	assert.match(http.calls[0].headers['User-Agent'], /^n8n-nodes-matchawards\//);
});

test('API Base URL option overrides the base, trailing slash dropped', async () => {
	const http = mock(page([]));
	await run({ httpRequest: http, params: search('contract', { options: { apiBaseUrl: 'https://staging.matchawards.com/' } }) });
	assert.equal(http.calls[0].url, 'https://staging.matchawards.com/api/public/v1/opportunities');
});

test('zero results -> zero items', async () => {
	const { out } = await run({ httpRequest: mock(page([])), params: search('contract') });
	assert.deepEqual(out, []);
});

// --- validation -----------------------------------------------------------------------------------------------

test('validation errors are thrown before any request', async () => {
	const http = mock(page([]));
	const cases = [
		[search('contract', { naics: '54151' }), /NAICS must be up to 10 six-digit codes/],
		[search('contract', { naics: Array(11).fill('541511').join(',') }), /NAICS/],
		[search('contract', { naics: '541511;541512' }), /NAICS/],
		[search('contract', { filters: { state: 'Virginia' } }), /two-letter US state code/],
		[search('job', { filters: { state: 'V1' } }), /two-letter US state code/],
		[search('grant', { filters: { keyword: 'a' } }), /Keyword must be 2 to 100 characters/],
		[search('contract', { filters: { keyword: 'x'.repeat(101) } }), /Keyword/],
		[search('contract', { filters: { postedWithinDays: 0 } }), /from 1 to 180/],
		[search('grant', { filters: { postedWithinDays: 181 } }), /from 1 to 180/],
		[search('job', { filters: { postedWithinDays: 31 } }), /from 1 to 30/],
		[search('contract', { limit: 0 }), /Limit must be a whole number from 1 to 50/],
		[search('contract', { limit: 51 }), /Limit/],
		[search('contract', { limit: 2.5 }), /Limit/],
		[get('a/b'), /ID must be the id field of a search result/],
		[get(''), /ID/],
		[get('x'.repeat(129)), /ID/],
	];
	for (const [params, pattern] of cases) await fails(params, http, pattern);
	assert.equal(http.calls.length, 0);
});

// --- paging ---------------------------------------------------------------------------------------------------

test('follows next_cursor for at most 3 requests, dedupes by id, asks only for what is missing', async () => {
	const http = mock(
		page(['1', '2'], { as_of: 'first', has_more: true, next_cursor: 'c1' }),
		page(['2', '3'], { as_of: 'second', has_more: true, next_cursor: 'c2' }),
		page(['4'], { has_more: true, next_cursor: 'c3' }),
		page(['5']),
	);
	const { out } = await run({ httpRequest: http, params: search('contract', { naics: '541511', limit: 10, options: { includePagingInfo: true } }) });
	assert.equal(http.calls.length, 3);
	assert.deepEqual(http.calls.map((c) => [c.qs.limit, c.qs.cursor, c.qs.naics]), [[10, undefined, '541511'], [8, 'c1', '541511'], [7, 'c2', '541511']]);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].json, {
		as_of: 'first', results: ['1', '2', '3', '4'].map(row), has_more: true, next_cursor: 'c3',
	});
});

test('stops once Limit is filled or has_more is false', async () => {
	const full = mock(page(['1', '2'], { has_more: true, next_cursor: 'c1' }));
	assert.equal((await run({ httpRequest: full, params: search('contract', { limit: 2 }) })).out.length, 2);
	assert.equal(full.calls.length, 1);
	const done = mock(page(['1'], { has_more: false, next_cursor: 'c1' }));
	await run({ httpRequest: done, params: search('contract', { limit: 5 }) });
	assert.equal(done.calls.length, 1);
});

test('a failed follow-up page keeps the rows and warns', async () => {
	const responses = () => [page(['1', '2'], { has_more: true, next_cursor: 'c1' }), { statusCode: 500, body: { error: 'boom' } }];
	const { out, hints } = await run({ httpRequest: mock(...responses()), params: search('contract', { limit: 5 }) });
	assert.deepEqual(out.map((x) => x.json.id), ['1', '2']);
	assert.equal(hints.length, 1);
	assert.equal(hints[0].type, 'warning');
	assert.equal(
		hints[0].message,
		'Stopped after 2 rows: MatchAwards server error (HTTP 500). It is temporary; retry in a minute. More results may exist; call again with next_cursor.',
	);
	const paged = await run({ httpRequest: mock(...responses()), params: search('contract', { limit: 5, options: { includePagingInfo: true } }) });
	assert.equal(paged.out[0].json.next_cursor, 'c1');
	assert.equal(paged.out[0].json.has_more, true);
	assert.match(paged.out[0].json.warning, /^Stopped after 2 rows: /);
	assert.equal(paged.hints.length, 0);
});

test('a malformed first page fails the call', async () => {
	await fails(search('contract'), mock({ statusCode: 200, body: { results: 'nope' } }), /results is not a list of objects/);
	await fails(search('contract'), mock({ statusCode: 200, body: '<html>' }), /unexpected response \(HTTP 200, not a JSON object\)/);
});

// --- error mapping --------------------------------------------------------------------------------------------

test('API errors use the MCP wording', async () => {
	const cases = [
		[{ statusCode: 429, headers: { 'retry-after': '17' }, body: { error: 'rate_limited' } },
			'MatchAwards rate limit reached (per IP: 60 requests per minute, 20 per 5 seconds). Wait 17 seconds, then retry.'],
		[{ statusCode: 429, body: { error: 'rate_limited', retry_after: 9 } }, /Wait 9 seconds/],
		[{ statusCode: 429, body: '' }, /Wait 60 seconds/],
		[{ statusCode: 503, body: { error: 'grants_unavailable' } },
			'Grant search is temporarily unavailable on MatchAwards. Try again later; contracts and jobs still work.'],
		[{ statusCode: 502, body: 'Bad Gateway' }, 'MatchAwards server error (HTTP 502). It is temporary; retry in a minute.'],
		[{ statusCode: 400, body: { error: 'invalid_parameter', parameter: 'naics', message: 'bad code' } },
			"MatchAwards rejected the parameter 'naics': bad code. Fix it and call again."],
		[{ statusCode: 400, body: '{"error":"invalid_parameter","parameter":"state"}' },
			"MatchAwards rejected the parameter 'state': invalid_parameter. Fix it and call again."],
		[{ statusCode: 422, body: { error: 'nope' } }, 'MatchAwards rejected the request (HTTP 422): nope'],
	];
	for (const [response, expected] of cases) {
		await assert.rejects(run({ httpRequest: mock(response), params: search('grant') }), (e) => {
			if (typeof expected === 'string') assert.equal(e.message, expected);
			else assert.match(e.message, expected);
			assert.equal(e.constructor.name, 'NodeApiError');
			assert.equal(e.httpCode, String(response.statusCode));
			return true;
		});
	}
});

test('404 on Get', async () => {
	await fails(get('123'), mock({ statusCode: 404, body: { error: 'not_found' } }), /^Not found on MatchAwards \(not_found\)\. Use an id from a search result\.$/);
});

test('timeout and network errors', async () => {
	const timeout = Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
	await fails(search('job'), mock(timeout), /^MatchAwards did not answer within 10 seconds\. Retry once/);
	const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
	await fails(search('job'), mock(refused), /^Could not reach MatchAwards at https:\/\/matchawards\.com \(ECONNREFUSED\)\. Check the network/);
});

// --- get / ids ------------------------------------------------------------------------------------------------

test('Get returns the full record with as_of; ids stay strings', async () => {
	const big = '12345678901234567890'; // > 2^53
	const http = mock({ statusCode: 200, body: `{"as_of":"A","result":{"id":"${big}","title":"T","description":"D","contacts":[{"name":"N","title":"CO"}]}}` });
	const { out } = await run({ httpRequest: http, params: get(` ${big} `) });
	assert.equal(http.calls[0].url, `${BASE}/${big}`);
	assert.deepEqual(http.calls[0].qs, {});
	assert.deepEqual(out, [{ json: { id: big, title: 'T', description: 'D', contacts: [{ name: 'N', title: 'CO' }], as_of: 'A' }, pairedItem: { item: 0 } }]);
	const num = mock({ statusCode: 200, body: { as_of: 'A', result: { id: '42' } } });
	await run({ httpRequest: num, params: get(42) });
	assert.equal(num.calls[0].url, `${BASE}/42`);
});

test('Get without a result object fails', async () => {
	await fails(get('1'), mock({ statusCode: 200, body: { as_of: 'A' } }), /no result object/);
});

// --- continueOnFail -------------------------------------------------------------------------------------------

test('continueOnFail: a failing item yields {error}, the others still run', async () => {
	const http = mock({ statusCode: 404, body: { error: 'not_found' } }, { statusCode: 200, body: { as_of: 'A', result: { id: '2' } } });
	const { out } = await run({
		httpRequest: http,
		continueOnFail: true,
		items: [{ json: {} }, { json: {} }, { json: {} }],
		params: [get('1'), get('2'), get('bad/id')],
	});
	assert.deepEqual(out, [
		{ json: { error: 'Not found on MatchAwards (not_found). Use an id from a search result.' }, pairedItem: { item: 0 } },
		{ json: { id: '2', as_of: 'A' }, pairedItem: { item: 1 } },
		{ json: { error: "ID must be the id field of a search result (letters, digits, '_' or '-', up to 128 characters)." }, pairedItem: { item: 2 } },
	]);
});

test('without continueOnFail the first failing item throws', async () => {
	await fails(get('1'), mock({ statusCode: 404, body: { error: 'not_found' } }), /Not found/);
});
