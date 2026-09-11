# YNAB API Review

Reviewed: September 10, 2026. Research only; no credentials or authenticated API calls used.

## Recommendation And Implementation Direction

Use the official API for an owner-operated local MCP, with a Personal Access Token (PAT). YNAB explicitly recommends PATs for accessing one's own account. Full API coverage means documented operations and fields, not parity with every YNAB UI feature.

- Pin the official OpenAPI JSON artifact, retaining its source URL, API version, and content hash for reproducibility.
- Expose one named MCP tool per operation, with JSON Schema input validation and a coverage check against the pinned specification.
- Use local stdio transport and Windows DPAPI CurrentUser protection for the stored token.
- Enable writes only through configuration plus `confirm: true` on write calls, enforced server-side.
- A confirmation boolean is not evidence of human consent: an agent can supply it. Require MCP client permission/approval for mutations as well.
- Fix outbound API traffic to `https://api.ynab.com/v1`; do not accept arbitrary hosts or forward credentials across redirects.
- Do not perform live mutation testing. Use fixtures, mocked transport, schema checks, and write-gate tests.
- These are implementation requirements, not claims about functionality already implemented.

## Current Versions And Recent Changes

The live official specification declares API **1.86.0**, released **July 1, 2026**, and OpenAPI **3.1.1**. The HTTP base remains `/v1`; the API revision, OpenAPI format version, and SDK package version are separate identifiers. [1][2]

| Version | Important change |
| --- | --- |
| 1.86.0, July 2026 | Category create/update accepts `goal_frequency`: `monthly`, `weekly`, or `yearly`. It replaces the existing target with a recurring `NEED` target, requires `goal_target`, cannot accompany `goal_target_date`, and is unsupported for Credit Card Payment categories. |
| 1.85.0, May 2026 | Plan/account/category/payee transaction listings default omitted `since_date` to one year ago. Explicit dates are essential for full history. Added inclusive `until_date` filtering, including month listings. |
| 1.84.0, May 2026 | Category and category-group responses gain `internal`, distinguishing system resources from user-created resources. |
| 1.83.0, April 2026 | Writable `goal_needs_whole_amount` selects "Set aside another" versus "Refill up to". Credit-card targets differ depending on whether `goal_target_date` accompanies `goal_target`. |
| 1.82.0, April 2026 | Monetary responses gain decimal `*_currency` and display `*_formatted` fields. Account creation adds `otherAsset` and `otherLiability`. |
| 1.81.0, March 2026 | Payee creation added. |
| 1.80.0, March 2026 | Account creation supports checking, savings, cash, and credit-card accounts. |
| 1.79.0, March 2026 | Primary paths change from `/budgets/{budget_id}` to `/plans/{plan_id}`; response keys become `plans`, `plan`, and `default_plan`. Old paths explicitly remain supported with old keys. |
| 1.78.0, February 2026 | Category/group creation, group updates, and money-movement/group reads added. Targets can be created through category writes. Prefer `goal_target_date`; `goal_target_month` is deprecated. |

Other relevant changes: scheduled-transaction update/delete arrived in March 2025; `debt_original_balance` is deprecated and always `null`; since January 2025, rate-limit `429` responses no longer include `X-Rate-Limit`. [2]

## API Semantics And Limitations

- **Authentication:** Bearer token in the Authorization header over HTTPS. PATs do not expire but can be revoked. OAuth tokens expire after two hours; authorization-code flow supports refresh tokens. [1]
- **Rate limit:** 200 requests per token per rolling hour, shared across consumers of that token. Cache, batch, and use deltas; do not assume a clock-hour reset or a rate-limit header on failures. [1]
- **Failures:** Distinguish invalid/revoked/expired tokens, subscription/trial failures, unauthorized scope, data limits, missing resources, conflicts, rate limits, and transient failures. Large requests can time out after 30 seconds. Avoid blind write retries after ambiguous network failures. [1]
- **Responses:** Success bodies have a `data` wrapper; errors have an `error` object. Preserve nullable values. For updates, omission and explicit `null` can differ: `goal_target: null` removes an existing target. [1][3]
- **Money:** Write amounts remain integer milliunits: 1,000 equals one unit of the plan's currency, not necessarily USD. Preserve three-decimal currencies and use integer arithmetic where possible. Formatted strings are for display, not calculations. [1][3]
- **Dates:** ISO date strings and UTC current-month semantics. Do not accidentally shift date-only values through local-time conversions. Month parameters support the documented `current` alias despite a date format annotation. [1][3]
- **Plan selection:** Prefer an explicit plan ID for writes. `last-used` can change independently; OAuth's `default` selection is a convenience, not a documented per-plan authorization boundary. [1][3]
- **Deltas:** Use `server_knowledge` with `last_knowledge_of_server` where supported. Merge changed entities and process `deleted` tombstones; do not replace a collection with a delta. Keep checkpoints scoped to the relevant plan/resource/filter set. [1][3]
- **Spec discrepancy:** The guide advertises money-movement/group delta support, but the reviewed live specification omits the corresponding query parameter on those operations. Do not silently invent generated parameters; document and resolve the discrepancy. [1][3]
- **History:** Explicitly request older history when needed. A successful response with omitted `since_date` is not a complete historical export. Transaction listings exclude pending transactions. [2][3]
- **Splits:** Category/payee transaction endpoints can return hybrid transaction/subtransaction records; avoid double-counting parents and children. Existing split subtransactions cannot be updated. Split date/amount changes are ignored, and parent recategorization is unsupported. [3]
- **Transfers:** Use account transfer payees. Credit Card Payment categories cannot be assigned to ordinary transactions and are ignored if supplied. Splits are disallowed on tracking accounts and transfers between on-budget accounts. [3]
- **Imports:** `import_id` is at most 36 characters, cannot be changed afterward, and participates in deduplication and matching. Matching can join same-account, same-amount manual entries within plus/minus 10 days. [3]
- **Bulk results:** Inspect saved transaction IDs and `duplicate_import_ids`; HTTP success does not imply every requested item was created. Updating by `id` versus `import_id` has distinct lookup rules. Verify intended write results rather than inferring success from queue counts. [3]
- **Scheduled transactions:** Separate endpoints; date must be in the future and no more than five years ahead. Create/update requires account and date. Creating scheduled splits is unsupported. Ordinary transaction creation does not accept future dates. [3]
- **Mutation scope:** No documented plan creation, account update/delete, category/group delete, or payee delete/merge endpoints. Supported account creation types are narrower than account response types: checking, savings, cash, creditCard, otherAsset, otherLiability. [3]
- **Assignments:** Monthly category updates set `budgeted` (assigned), not a relative increment. A two-category move is not a documented atomic operation. Money-movement endpoints expose records, not a general money-transfer write API. [3]
- **Schema limits:** Some restrictions exist only in descriptions, including conditional target rules and special aliases. JSON Schema validation alone does not enforce every business rule; maintain small, reviewed semantic checks. [3]

## SDK And Library Choices

The official JavaScript SDK repository reports package **`ynab` 4.5.0**, generated from API **1.85.0**, requiring **Node >=22**. It uses OpenAPI Generator, provides TypeScript models and CommonJS/ESM/browser builds, and is Apache-2.0 licensed. These are inspected repository versions, not an independently verified npm publication state. [4][5]

Its generated `SaveCategory` serializer enumerates known properties and lacks `goal_frequency`. Passing an extra property through a type escape does not make the serializer transmit it. Regeneration or a narrowly scoped direct request is required for this 1.86 capability. The SDK exposes API errors; it does not replace application-level rate, privacy, or mutation controls. [6]

OpenAPI-driven tool generation avoids both endpoint omissions and field-level drift. Preserve request enums, nullable types, required properties, response fields, and operation IDs; compare coverage whenever updating the pinned artifact. Prefer this complete foundation over an arbitrary-URL HTTP tool. Useful curated workflows can be layered above it without weakening write gates.

- **Official Ruby:** `ynab` on RubyGems, maintained in `ynab/ynab-sdk-ruby`; appropriate for Ruby applications. [1][7]
- **Official Python:** `ynab` on PyPI, maintained in `ynab/ynab-sdk-python`; appropriate for Python applications and analysis workflows. [1][8]
- **Version caution:** Ruby/Python package freshness and 1.86 field coverage were not independently audited in this review; do not assume they match the live API.
- **Community ecosystem:** YNAB lists .NET, Elixir, Go, Java, Julia, Kotlin, Perl, PHP, PowerShell, R, Rust, and Swift clients. Choose by runtime fit, maintenance, spec coverage, licensing, and credential handling, not listing status alone. YNAB does not support these clients. [1]

## Existing MCP Options

The listed Oliver Ames local MCP is a substantial reference: stdio, official SDK plus direct requests, read-only defaults, write gates, rate-aware transport, batch verification, and an undo journal. Its inspected repository package is **5.2.0** and its README advertises API **1.85** coverage. [9]

- Its source lacks `goal_frequency`, omits `internal` from category outputs, and accepts loan account creation types outside the official request enum. Some dollar-oriented analytics round aggregates to two decimals. Its "full coverage" claim is not exact 1.86 field coverage. [10]
- It automatically reads Claude/Codex settings unless `YNAB_DISABLE_AGENT_CONFIG_FALLBACK=1`. Plugin installs explicitly enable writes, unlike direct registration defaults. These behaviors are not appropriate to copy into a tightly scoped credential design without review. [9][10]
- The local JSON undo journal contains financial before-state. Undo is not a transaction rollback or complete backup; recreating deleted transactions cannot restore original bank-import linkage. [9][10]
- Hosted Smirnov MCP uses OAuth, retains OAuth state, and briefly caches some plan data in Cloudflare KV for up to five minutes. Its policy says plan contents are not retained in logs. These are provider claims, not an independent security audit. [11][12]
- Ames also offers hosted OAuth. Its policy describes AES-GCM-encrypted tokens and undo entries in Cloudflare KV, retained until deletion, and explicitly identifies delivery of tool results to the connected MCP client. [13]
- Hosted options suit clients requiring remote HTTP but add operator/infrastructure trust and retention considerations. Neither listing means official YNAB support or endorsement. Local stdio better matches this single-owner project's scope. [1]

## Terms, OAuth, And Privacy

This is a documentation-based assessment, not legal advice. The API terms incorporate YNAB's general terms, privacy policy, documentation terms, and applicable policies. The API page's legal section is marked last updated May 28, 2025. [14]

- **Owner-only PAT:** Explicitly supported for the account owner's personal use. Do not share PATs, request someone else's PAT, or send one to a hosted connector. The OAuth-specific publication/review requirements are not stated as prerequisites for an owner-only PAT tool. [1][15]
- **Token scope:** A local read-only switch is application enforcement, not a documented read-only PAT scope. DPAPI CurrentUser protects storage, not a token already decrypted in memory or code running as the same user.
- **Permitted access:** Use authorized documented API access, handle tokens securely, never directly request/handle/store bank-account credentials, and do not circumvent API limits. Terms allow secure storage of financial-institution OAuth access tokens. [14]
- **Business restrictions:** No copying/duplicating YNAB products or services or false implication of endorsement. Public attribution should follow the required disclaimer and permitted "for YNAB" naming/branding guidance. [14][15]
- **Operational risk:** YNAB may suspend access immediately and change the API or terms. The service is provided as-is/as-available, with liability disclaimers and indemnification obligations. A private MCP is not exempt from general terms. [14]
- **Other users:** OAuth is mandatory for obtaining access to accounts you do not own. Restricted mode allows 25 access tokens for non-owner users; removing it requires review, estimated at two to four weeks. [1]
- **OAuth requirements:** Publish an accurate, dated privacy policy explaining purposes, access, storage, security, retention, sharing, and deletion. Honor deletion requests, seek consent before changed data uses, request minimum permissions, maintain a secure environment, and do not sell analyzed/aggregated YNAB user data. [15]
- **OAuth security:** YNAB documents `read-only` scope, `state`, and S256 PKCE. Prefer authorization-code flow with PKCE/state where the secret can be protected. Its documented exchange still includes `client_secret`; do not assume secretless public-client support. Implicit flow is documented but lacks refresh tokens. [1]
- **AI data exposure:** Local execution does not keep tool results away from a cloud AI provider. Transactions, memos, balances, and payee GPS locations may enter chat history, telemetry, or provider storage. Minimize returned data and review MCP client/provider retention settings.
- **Practical boundary:** Keep credentials out of tool schemas, results, logs, and model context. Treat payee names/memos as untrusted data, not instructions. Protect any caches, exports, and journals separately; avoid unnecessary location/full-plan disclosures.
- **Consent:** The reviewed terms do not expressly prohibit owner-authorized AI assistance, but this is not blanket approval of downstream data handling. Client permission remains necessary even when a tool supplies `confirm: true`.

## Sources

1. API guide, authentication, formats, deltas, rate limits, and library listings: https://api.ynab.com/
2. Official changelog: https://api.ynab.com/#changelog
3. Official live specification reviewed (YAML representation): https://api.ynab.com/papi/open_api_spec.yaml
4. Official JavaScript SDK: https://github.com/ynab/ynab-sdk-js
5. SDK package metadata: https://github.com/ynab/ynab-sdk-js/blob/main/package.json
6. SDK category serializer: https://github.com/ynab/ynab-sdk-js/blob/main/src/models/SaveCategory.ts
7. Official Ruby SDK: https://github.com/ynab/ynab-sdk-ruby
8. Official Python SDK: https://github.com/ynab/ynab-sdk-python
9. Listed local MCP: https://github.com/oliverames/ynab-mcp-server
10. Local MCP implementation: https://github.com/oliverames/ynab-mcp-server/blob/main/index.js
11. Hosted MCP: https://mcpforynab.smirnovlabs.com
12. Hosted MCP privacy: https://mcpforynab.smirnovlabs.com/privacy
13. Ames hosted privacy: https://ynab.amesvt.com/privacy
14. API terms: https://api.ynab.com/#terms ; incorporated terms: https://www.ynab.com/terms/ ; privacy: https://www.ynab.com/privacy-policy/
15. OAuth requirements and user data policy: https://api.ynab.com/#oauth-requirements
