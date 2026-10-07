# Reference

Tools, API behavior, security properties and maintenance for the server. For setup see [configuration](configuration.md).

## Tools

One snake_case tool is generated per OpenAPI `operationId`. `getPlans` becomes `ynab_get_plans`. Run `npm run check` for the full method, path and tool inventory. Read `ynab://guide` for model-facing usage instructions.

| Area | Capabilities |
| --- | --- |
| User and plans | Current user, list plans, export a plan, settings |
| Accounts | List, retrieve, create |
| Categories and groups | List and retrieve categories, create and update categories and groups, category targets, monthly assigned amounts |
| Payees and locations | List, retrieve, create and update payees, read payee GPS locations |
| Months | List months, monthly plan detail |
| Money movements | Read movements and movement groups, including month filters |
| Transactions | List, filter, retrieve, create single or bulk, update single or bulk, delete, trigger linked-account import |
| Scheduled transactions | List, retrieve, create, update, delete |

Path and query parameters are top-level arguments. Request payloads go in `body` and keep YNAB's wrapper objects. Responses keep the complete upstream JSON under `response`, with the HTTP `status` and the rate-limit header when present. Errors set `isError`, a readable `error`, and structured API information under `details`. No financial field is removed and no amount is converted.

Read example:

```json
{
  "name": "ynab_get_transactions",
  "arguments": {
    "plan_id": "PLAN_UUID",
    "since_date": "2026-01-01",
    "until_date": "2026-09-10"
  }
}
```

Write example, only after you authorize the exact change:

```json
{
  "name": "ynab_update_month_category",
  "arguments": {
    "plan_id": "PLAN_UUID",
    "month": "current",
    "category_id": "CATEGORY_UUID",
    "body": { "category": { "budgeted": 125000 } },
    "confirm": true
  }
}
```

This sets the month's assignment to 125 currency units. It does not add 125 to the existing amount. Identifiers are placeholders.

## Writes

Writes are off by default. `YNAB_ALLOW_WRITES=true` turns them on. Every write also needs `confirm: true` and a concrete plan ID instead of the moving `last-used` or OAuth `default` alias. A confirmation boolean does not prove that a human agreed, so enforce approval in the MCP client and do not globally allow every mutation.

## API semantics

- Money inputs are integer milliunits. 1000 is one unit of the plan currency and -12500 is an outflow of 12.50. The server rejects unsafe JavaScript integers. New decimal or display response fields do not change write units.
- Dates use `YYYY-MM-DD` in UTC. Month parameters also accept `current`.
- Transaction listings default to one year of history. Ask for an older `since_date` to go further back. The API does not return pending bank transactions.
- Delta queries exist only where the pinned schema advertises them. Merge changes, honor deleted tombstones, and keep `server_knowledge` scoped to the resource and filters. The server stores no checkpoints and caches nothing.
- The server rejects unknown request properties. JSON Schema validates enums, formats, nullability, required fields and composed schemas. Extra checks cover single versus bulk creation, bulk identifiers and `goal_frequency` dependencies. YNAB stays authoritative for business rules that depend on stored data.
- Omitted fields and explicit `null` differ, especially when clearing category targets. Splits, transfers, scheduled transactions and credit-card categories have extra restrictions in the tool schemas and the API review.
- The API has no plan creation, account update or delete, category or payee delete or merge, or atomic money-movement write. Those gaps come from YNAB, so the server has no matching tools.

## Security and reliability

- The HTTPS destination is fixed to `https://api.ynab.com/v1`. Tools cannot supply a URL, authorization header or credential. The server rejects redirects.
- API calls time out after 35 seconds and honor MCP cancellation. There are no automatic retries. A failed or timed out write may have succeeded, so inspect state before retrying.
- Client cancellation, timeout or disconnection can hide the server's error result. A cancelled write has an unknown outcome, and cancelling does not roll it back.
- A local limiter caps each process at 200 requests per rolling hour. YNAB's own limit is 200 per hour per token across all processes and clients. HTTP 429 honors `Retry-After`, and otherwise the process pauses for one hour. Restarting does not reset YNAB's limit.
- The token never appears in process arguments, tool arguments or MCP results. DPAPI protects the credential at rest and does not protect against other programs running as your Windows account. Node and PowerShell hold the decrypted token in memory while running.
- The server writes no application logs, financial-data files or telemetry, and keeps no undo journal. The upstream schema and fabricated test data are the only bundled data.
- Names, memos and other API text are untrusted data. Review tool output before acting on it.
- Running locally does not keep returned data away from your LLM provider. Conversations, tool traces and backups can contain financial data or GPS locations, so prefer specific requests to full exports.
- Some operations, such as linked-bank imports and deletion, cannot be undone.

## Verification and maintenance

```sh
npm test
npm run check
npm audit
npm run smoke
```

Tests use fabricated credentials and mock HTTP, and they exercise every documented endpoint and the MCP protocol. They do not establish live write behavior or every YNAB business-rule combination. `smoke` is described in [configuration](configuration.md#4-verify).

The API snapshot is `spec/openapi.json`, taken from [YNAB's OpenAPI specification](https://api.ynab.com/papi/open_api_spec.yaml). You update it by hand, and the server never updates it at startup.

```sh
npm run spec:update
npm test
npm run check
```

Review upstream schema diffs, operation counts, security annotations and new business rules before committing. Tests pin the known operation count. The server has no legacy `/budgets` aliases because the `/plans` operations cover the full current API.

See [the API and SDK review](api-review.md) for documentation findings, supported libraries, comparisons with existing MCP servers, legal and privacy notes, and sources. YNAB support is `api@ynab.com` and status is at [ynabstatus.com](https://ynabstatus.com).
