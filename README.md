# MCP for YNAB

![MCP for YNAB banner](docs/assets/banner.svg)

[![CI](https://github.com/cri9913/ynab-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/cri9913/ynab-mcp/actions)
[![License](https://img.shields.io/github/license/cri9913/ynab-mcp)](LICENSE)
[![Stars](https://img.shields.io/github/stars/cri9913/ynab-mcp)](https://github.com/cri9913/ynab-mcp)

A local stdio MCP server that exposes all 44 operations of YNAB API 1.86.0, 28 reads and 16 writes. It lets an assistant read and manage your budget with no hosted intermediary and no HTTP listener.

It generates a tool per operation from the pinned OpenAPI schema instead of wrapping SDK methods, so it covers everything the API can do. It is for the account owner's own use, is unaffiliated with YNAB, and must not collect other people's tokens.

## Usage

Requires Node.js 22 or newer.

```sh
npm ci --ignore-scripts
export YNAB_ACCESS_TOKEN=...   # or store it with the Windows DPAPI script
npm run smoke                  # one read-only GET /user through the real server
```

Then point an MCP client at `node /absolute/path/to/src/index.js`. Writes stay off until you set `YNAB_ALLOW_WRITES=true`.

Step by step token storage, client setup for Copilot CLI, Claude Code and OpenCode, and troubleshooting are in [docs/configuration.md](docs/configuration.md).

## Examples

Ask your assistant in plain language. It calls the generated tools.

```text
use the mcp-ynab agent to summarize my budget for this month
```

A read call. Path and query parameters are top-level arguments.

```json
{ "name": "ynab_get_transactions", "arguments": { "plan_id": "PLAN_UUID", "since_date": "2026-01-01" } }
```

A write sets a month's assignment to 125 units. It needs `YNAB_ALLOW_WRITES=true`, `confirm: true` and a concrete plan ID.

```json
{ "name": "ynab_update_month_category", "arguments": { "plan_id": "PLAN_UUID", "month": "current", "category_id": "CATEGORY_UUID", "body": { "category": { "budgeted": 125000 } }, "confirm": true } }
```

Every tool, the money and date rules, and the security properties are in [docs/reference.md](docs/reference.md).

## Thought process

- One tool per OpenAPI operation. This covers the whole API and costs a large tool list, so prefer specific requests.
- Writes are off by default and need a confirmation and a concrete plan ID. This costs one extra step and removes accidental changes.
- The API host is fixed and the token never appears in arguments or results. This costs flexibility and removes a class of credential leaks.
- The OpenAPI snapshot is committed and updated by hand. This costs a manual step and stops the API shape from changing at startup.
- The server keeps no logs, cache or telemetry. This means you cannot replay a request later, and no financial data reaches disk.

See the [API and SDK review](docs/api-review.md) for sources and comparisons.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
