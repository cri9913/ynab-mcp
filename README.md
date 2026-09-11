# MCP for YNAB

Personal, local stdio MCP server exposing **all 44 operations in YNAB API 1.86.0**: 28 reads and 16 writes. Uses the official MCP SDK and pinned YNAB OpenAPI schemas, not an incomplete subset of SDK methods. No HTTP listener or hosted intermediary.

Not affiliated with, endorsed by, or sponsored by YNAB. Intended for the account owner's personal use, not for collecting other users' personal access tokens.

## Setup

Requires Node.js 22 or newer. Windows DPAPI authentication requires Windows PowerShell 5.1 and the Windows account/computer that stored the key.

```powershell
npm ci --ignore-scripts
npm test
npm run check
```

The existing encrypted credential is used automatically:

```text
%LOCALAPPDATA%\LocalSecrets\ynab api key.xml
```

To store or replace the token using a local masked dialog:

```powershell
powershell.exe -NoProfile -STA -File .\scripts\credential.ps1 -Action Set
```

This is compatible with the previously created `ynab-api-key.ps1` helper. The CLIXML file contains a DPAPI-encrypted SecureString. Do not commit it, even to a private repository. Never run the bundled credential script's `Get` action through an assistant terminal tool: it is an internal interface for the server's private pipe, not a display command.

Authentication order:

1. `YNAB_ACCESS_TOKEN`, if set. Supply through a trusted secret manager, not an LLM prompt or a checked-in configuration file.
2. On Windows, DPAPI CLIXML at `YNAB_SECRET_PATH` or the default path above.
3. On other platforms, fail with an instruction to configure `YNAB_ACCESS_TOKEN`.

No token is passed in process arguments, tool arguments, or MCP results. DPAPI protects the credential at rest, not against other programs running as your Windows account. Node and PowerShell necessarily hold the decrypted token temporarily in process memory.

## MCP Configuration

For OpenCode, merge this into your configuration and replace the script path with its absolute location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ynab": {
      "type": "local",
      "command": ["node", "C:/path/to/ynab-mcp/src/index.js"],
      "enabled": true,
      "timeout": 45000,
      "environment": { "YNAB_ALLOW_WRITES": "true" }
    }
  },
  "permission": { "ynab_*": "ask" }
}
```

Quit and restart OpenCode after changing configuration. Other stdio MCP clients can use the same Node executable and script path, adapting their own configuration and permission syntax. Their call timeout should exceed the server's 35-second API timeout.

**Writes are disabled by default.** `YNAB_ALLOW_WRITES=true` enables them. Every write additionally requires `confirm: true` and a concrete plan ID rather than the moving `last-used` or OAuth `default` alias. A confirmation boolean is not proof of human consent: enforce user approval in the MCP client. Do not globally allow all mutations just because the server provides them.

## Tools

One snake_case tool is generated per OpenAPI `operationId`; `getPlans` becomes `ynab_get_plans`. Run `npm run check` for the complete method/path/tool inventory. Read `ynab://guide` for model-facing usage instructions.

| Area | Capabilities |
| --- | --- |
| User and plans | Current user, list plans, export a plan, settings |
| Accounts | List, retrieve, create |
| Categories and groups | List/retrieve categories, create/update categories and groups, category targets, monthly assigned amounts |
| Payees and locations | List/retrieve/create/update payees; read payee GPS locations |
| Months | List months, monthly plan detail |
| Money movements | Read movements and movement groups, including month filters |
| Transactions | List/filter/retrieve, create single or bulk, update single or bulk, delete, trigger linked-account import |
| Scheduled transactions | List/retrieve/create/update/delete |

Path and query parameters are top-level arguments. Request payloads go in `body`, preserving YNAB's wrapper objects. Responses preserve the complete upstream JSON under `response`, together with HTTP `status` and the rate-limit header when available. Errors use `isError`, a readable `error`, and structured API information under `details`. No financial fields are silently removed or amounts converted.

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

Write example, only after authorizing the exact change:

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

This **sets** the month's assignment to 125 currency units; it does not add 125 to the existing amount. Example identifiers are placeholders, not real account data.

## API Semantics

- Money inputs use integer **milliunits**: 1000 is one unit of the plan currency; -12500 is an outflow of 12.50. Unsafe JavaScript integers are rejected. New decimal/display response fields do not change write units.
- Dates use `YYYY-MM-DD`, UTC. Month parameters also accept `current`.
- Transaction listings default to one year of history. Request older `since_date` explicitly. Pending bank transactions are not returned.
- Delta queries are available only where advertised by the pinned schema. Merge changes, honor deleted tombstones, and keep `server_knowledge` scoped to the relevant resource and filters. This server does not persist checkpoints or cache responses.
- Unknown request properties are rejected rather than silently ignored. JSON Schema validates enums, formats, nullability, required fields, and composed schemas. Additional checks cover single-versus-bulk creation, bulk identifiers, and `goal_frequency` dependencies. YNAB remains authoritative for resource-dependent business rules.
- Preserve omitted versus explicit `null` fields, especially when clearing category targets. Splits, transfers, scheduled transactions, and credit-card categories have additional restrictions described in the tool schemas and API review.
- The API does not expose every UI action: no plan creation, account update/delete, category/payee delete/merge, or atomic money-movement write. These are not missing MCP implementations.

## Security And Reliability

- HTTPS destination is fixed to `https://api.ynab.com/v1`. Tools cannot supply a URL, authorization header, or credential. Redirects are rejected.
- API traffic times out after 35 seconds and respects MCP cancellation. No automatic retries. A failed/timed-out write may already have succeeded; inspect affected state before retrying.
- Client cancellation, client timeout, or disconnection can suppress the server's error result entirely. A cancelled write still has an unknown outcome even if no warning is received; cancellation is not rollback.
- Local rolling-hour limiter caps each process at 200 requests. YNAB's actual 200/hour limit is **per token across all processes and clients**. HTTP 429 honors `Retry-After` if supplied; otherwise this process pauses requests for one hour. Restarting does not reset YNAB's limit.
- No application logs of requests, responses, or credentials, no financial-data files, no telemetry, and no undo journal. The upstream schema and non-secret tests are the only bundled data.
- Names, memos, and other API text are untrusted data, not instructions. Review tool output before acting on it.
- Local execution does not keep returned data out of the LLM provider's systems. Client conversations, tool traces, retention settings, and backups can contain financial data or GPS locations. Prefer specific requests to full exports.
- There is no rollback service. Some operations, such as linked-bank imports or deletion, cannot be faithfully undone.

## Verification And Maintenance

```powershell
npm test
npm run check
npm audit
npm run smoke
```

`smoke` uses the stored credential for **one GET /user** through the real stdio MCP connection, prints only pass/fail and tool count, and performs no mutations. Automated tests use fabricated credentials and mock HTTP, exercising every documented endpoint and the MCP protocol. They do not establish live write behavior or all YNAB business-rule combinations.

The API snapshot is committed in `spec/openapi.json`, sourced from [YNAB's official OpenAPI specification](https://api.ynab.com/papi/open_api_spec.yaml). Updating is explicit, never automatic at server startup:

```powershell
npm run spec:update
npm test
npm run check
```

Review upstream schema diffs, operation counts, security annotations, and new business rules before committing. Tests intentionally pin the known operation count. No legacy `/budgets` aliases are duplicated; supported modern `/plans` operations provide the full current API surface.

See [the API and SDK review](docs/api-review.md) for documentation findings, supported libraries, existing MCP comparisons, legal/privacy considerations, and sources. YNAB support: `api@ynab.com`; status: [ynabstatus.com](https://ynabstatus.com).
