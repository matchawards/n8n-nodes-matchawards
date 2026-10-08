// Live smoke against staging: Contract Search (NAICS 541511, limit 2), then Get of the first id.
// Same fake-execute harness as the tests, with n8n's httpRequest replaced by fetch.
const { run } = require('./harness');

const base = process.env.MATCHAWARDS_API_BASE || 'https://staging.matchawards.com';

async function httpRequest(o) {
	const url = new URL(o.url);
	for (const [k, v] of Object.entries(o.qs || {})) url.searchParams.set(k, String(v));
	const r = await fetch(url, { method: o.method, headers: o.headers, signal: AbortSignal.timeout(o.timeout) });
	const text = await r.text();
	let body = text;
	try {
		body = JSON.parse(text);
	} catch {}
	console.log(`GET ${url} -> ${r.status}`);
	return { statusCode: r.status, statusMessage: r.statusText, headers: Object.fromEntries(r.headers), body };
}

(async () => {
	const options = { apiBaseUrl: base };
	const s = await run({ httpRequest, params: { resource: 'contract', operation: 'search', naics: '541511', limit: 2, options } });
	console.log(`search: ${s.out.length} items`, s.out.map((x) => ({ id: x.json.id, title: x.json.title })));
	if (!s.out.length) throw new Error('search returned no rows');
	const id = s.out[0].json.id;
	if (typeof id !== 'string') throw new Error(`id is ${typeof id}, expected string`);
	const g = await run({ httpRequest, params: { resource: 'contract', operation: 'get', id, options } });
	const r = g.out[0].json;
	console.log('get:', { id: r.id, title: r.title, as_of: r.as_of, contacts: r.contacts, description: String(r.description ?? '').slice(0, 80) });
	if (r.id !== id) throw new Error('get returned a different id');
	console.log('SMOKE OK');
})().catch((e) => {
	console.error('SMOKE FAILED:', e.message);
	process.exit(1);
});
