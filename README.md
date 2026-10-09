# n8n-nodes-matchawards

An [n8n](https://n8n.io) community node for [MatchAwards](https://matchawards.com): search US government
contract opportunities (federal and state), grants and jobs, and fetch the full record of one, including its
description and points of contact. Read-only. The public MatchAwards API needs no account and no key, so the
node has no credentials.

It is the n8n version of the [MatchAwards MCP server](https://github.com/matchawards/matchawards-mcp), with the
same filters, validation, paging and error messages.

## Install

In n8n: **Settings → Community Nodes → Install**, enter `n8n-nodes-matchawards`, confirm. The **MatchAwards**
node then shows up in the node panel. It can also be used as a tool by an n8n AI Agent.

Self-hosted without the UI: `cd ~/.n8n/nodes && npm install n8n-nodes-matchawards`, then restart n8n.

## Credentials

None. The public MatchAwards API needs no account and no API key.

## Operations

| Resource | Operation | Fields | Covers MCP tool |
|---|---|---|---|
| Contract | Search | NAICS, Level (both / federal / state), Limit; filters: State, Keyword, Set-Aside, Posted Within Days (1-180), Include Closed, Cursor | `search_contracts`, `search_by_naics` (type contract / federal / state) |
| Contract | Get | ID | `get_opportunity`, `find_contacts` |
| Grant | Search | NAICS, Limit; filters: Keyword, Posted Within Days (1-180), Include Closed, Cursor | `search_grants`, `search_by_naics` (type grant) |
| Grant | Get | ID | `get_opportunity`, `find_contacts` |
| Job | Search | NAICS, Limit; filters: State, Keyword, Posted Within Days (1-30, default 30), Cursor | `search_jobs`, `search_by_naics` (type job) |
| Job | Get | ID | `get_opportunity`, `find_contacts` |

- **NAICS** is the first field of every search and takes up to 10 six-digit codes, comma-separated
  (`541511,541512`). A search with only NAICS set is what the MCP calls `search_by_naics`.
- **Get** returns the full record: the search row plus `description` (up to 2000 characters) and
  `contacts` (`[{name, title}]`, empty when none are published). That covers both `get_opportunity` and
  `find_contacts`. Get works the same under every resource; the id decides the record.
- **Limit** is 1 to 50 (default 50). When a filter is sparse, a search follows the API cursor for up to
  3 requests to fill it, dropping duplicates.
- **Include Closed** off (the default) keeps only items whose response deadline is today or later (US Eastern);
  an item with no deadline counts as closed.

### Output

- **Search** emits one item per result row: `id`, `type`, `title`, `agency`, `office`, `naics {code, title}`,
  `set_aside`, `state`, `city`, `posted_at`, `response_deadline`, `url` (matchawards.com), `sam_url`,
  `solicitation_number`. No results means no items; turn on the node setting *Always Output Data* if the next
  node must run anyway.
- **Options → Include Paging Info** emits a single item `{as_of, results, has_more, next_cursor}` instead. Pass
  `next_cursor` as the **Cursor** filter, with the same filters, to get the next page. If a follow-up page fails,
  the rows collected so far are kept and a `warning` says so. A `warning` also appears when the 3 requests ran out
  before Limit was filled. With paging info off, the warning is shown as an execution hint.
- **Get** emits one item with the record and `as_of`.
- `id` is always a string. It is longer than a JavaScript number can hold exactly, so never convert it.

Errors carry the API's advice (rate limit with the wait time, grants unavailable, bad parameter, not found). With
*Continue On Fail* on, a failing input item yields `{error}` and the others still run.

## Example workflow

New IT contracts in Slack every morning: **Schedule Trigger** (daily, 8:00) → **MatchAwards** Contract Search,
NAICS `541511`, Posted Within Days `1`, Limit `50` → **Slack** post `{{ $json.title }} {{ $json.url }}`.
Import [`examples/daily-contracts-to-slack.json`](examples/daily-contracts-to-slack.json) and pick your Slack
credentials and channel.

## Rate limit

The API allows 60 requests per minute and 20 per 5 seconds per IP address. One search makes 1 to 3 requests.
On HTTP 429 the node tells you how many seconds to wait.

## Compatibility

Tested with n8n 2.42.6 (self-hosted, Node.js 24). No runtime dependencies.

## Resources

- [MatchAwards](https://matchawards.com)
- [MatchAwards public API](https://matchawards.com/api/public/v1/) (a JSON description of the endpoints and parameters)
- [MatchAwards MCP server](https://github.com/matchawards/matchawards-mcp), the same search for AI agents
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm ci          # on Node 26+: npm ci --ignore-scripts (isolated-vm, a dev-only dependency, has no build there)
npm run lint    # n8n-node lint, the same rules as the n8n Creator Portal scan
npm test        # n8n-node build, then node:test against a mocked API, no network
npm run smoke   # one search + one get against https://staging.matchawards.com (MATCHAWARDS_API_BASE overrides)
```

## Releasing

n8n verifies only community nodes published from GitHub Actions with npm provenance, so this package is never
published from a laptop (`npm publish` refuses unless run by `npm run release`). `npm run release` on `main` lints,
builds, bumps the version, tags and pushes; the tag runs `.github/workflows/publish.yml`, which publishes with
provenance. Update `CHANGELOG.md` and the operations table above in the same change as any new operation.

## License

[MIT](LICENSE)
