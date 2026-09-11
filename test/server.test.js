import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { operations, spec } from '../src/catalog.js';
import { ApiError, YnabApi } from '../src/api.js';
import { createServer, guide } from '../src/server.js';

const id = '11111111-1111-4111-8111-111111111111';
const transaction = { account_id: id, date: '2026-09-01', amount: -12500, memo: 'Test purchase', approved: false };
const bodies = {
  createAccount: { account: { name: 'Test account', type: 'checking', balance: 12000 } },
  createCategory: { category: { name: 'Test category', category_group_id: id, note: null, goal_target: 50000, goal_frequency: 'monthly' } },
  updateCategory: { category: { name: 'Updated category', goal_target: null } },
  updateMonthCategory: { category: { budgeted: 50000 } },
  createCategoryGroup: { category_group: { name: 'Test group' } },
  updateCategoryGroup: { category_group: { name: 'Updated group' } },
  createPayee: { payee: { name: 'Test payee' } },
  updatePayee: { payee: { name: 'Updated payee' } },
  createTransaction: { transaction: { ...transaction, import_id: 'test-import-1' } },
  updateTransactions: { transactions: [{ id: null, import_id: 'test-import-1', memo: null, amount: -15000 }] },
  importTransactions: undefined,
  updateTransaction: { transaction: { ...transaction, category_id: null } },
  deleteTransaction: undefined,
  createScheduledTransaction: { scheduled_transaction: { account_id: id, date: '2027-01-01', amount: -10000, frequency: 'monthly' } },
  updateScheduledTransaction: { scheduled_transaction: { account_id: id, date: '2027-02-01', memo: null, frequency: 'weekly' } },
  deleteScheduledTransaction: undefined,
};

function sample(operation) {
  const args = {};
  for (const parameter of operation.parameters) {
    const schema = parameter.schema;
    args[parameter.name] = parameter.name === 'month' ? 'current'
      : schema.enum ? schema.enum[0]
        : schema.format === 'date' ? '2024-02-29'
          : schema.type === 'boolean' ? false
            : schema.type === 'integer' ? 0 : id;
  }
  if (operation.write) {
    assert.ok(Object.hasOwn(bodies, operation.operationId), `Missing write sample: ${operation.operationId}`);
    args.confirm = true;
    if (bodies[operation.operationId] !== undefined) args.body = structuredClone(bodies[operation.operationId]);
  }
  return args;
}

async function connect(t, { allowWrites, api, fetchImpl } = {}) {
  const calls = [];
  api ??= new YnabApi('fake-server-test-token', {
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return fetchImpl ? fetchImpl(url, init) : Response.json({ data: { marker: 'mock-only', nullable: null } });
    },
  });
  const server = createServer(api, { allowWrites });
  const client = new Client({ name: 'ynab-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, serverTransport };
}

function decoded(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, value);
  return value;
}

async function rejected(client, calls, operation, args, pattern = /Invalid tool arguments/) {
  const before = calls.length;
  const result = await client.callTool({ name: operation.name, arguments: args });
  assert.equal(result.isError, true);
  const value = decoded(result);
  assert.match(value.error, pattern);
  assert.equal(calls.length, before, 'Rejected input must not make an HTTP request');
  return value;
}

test('MCP listTools matches all 44 specification operations exactly, with 28 GET and 16 writes', async t => {
  const { client, calls } = await connect(t);
  const expected = Object.entries(spec.paths).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']
      .filter(method => item[method])
      .map(method => ({ path, method: method.toUpperCase(), operationId: item[method].operationId,
        name: `ynab_${item[method].operationId.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}` })));
  assert.equal(expected.length, 44);
  assert.equal(expected.filter(op => op.method === 'GET').length, 28);
  assert.equal(expected.filter(op => op.method !== 'GET').length, 16);
  assert.deepEqual(operations.map(({ path, method, operationId, name }) => ({ path, method, operationId, name })), expected);
  const { tools, nextCursor } = await client.listTools();
  assert.equal(nextCursor, undefined);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 44);
  assert.deepEqual(tools, operations.map(op => op.tool));
  for (const operation of expected) {
    const tool = tools.find(tool => tool.name === operation.name);
    const write = operation.method !== 'GET';
    assert.deepEqual(tool.annotations, { title: spec.paths[operation.path][operation.method.toLowerCase()].summary,
      readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true });
    assert.ok(tool.description.includes(`${operation.method} ${operation.path}`));
  }
  assert.equal(calls.length, 0);
});

test('all advertised input schemas compile independently and validate representative inputs', async t => {
  const { client } = await connect(t);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  ajv.addFormat('int32', { type: 'number', validate: value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 });
  for (const tool of (await client.listTools()).tools) {
    const validate = ajv.compile(tool.inputSchema);
    const args = sample(operations.find(op => op.name === tool.name));
    assert.equal(validate(args), true, `${tool.name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(JSON.stringify(tool.inputSchema).includes('"$ref"'), false);
  }
});

test('every operation executes end-to-end with the exact mocked HTTP method, path, query and body', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  for (const operation of operations) {
    await t.test(`${operation.method} ${operation.operationId}`, async () => {
      const args = sample(operation);
      const original = structuredClone(args);
      const before = calls.length;
      const result = await client.callTool({ name: operation.name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(decoded(result)));
      assert.deepEqual(decoded(result), { status: 200, response: { data: { marker: 'mock-only', nullable: null } } });
      assert.equal(calls.length, before + 1);
      const { url, init } = calls.at(-1);
      assert.equal(url.origin, 'https://api.ynab.com');
      assert.equal(url.pathname, `/v1${operation.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(args[key]))}`);
      assert.deepEqual([...url.searchParams], operation.parameters.filter(p => p.in === 'query').map(p => [p.name, String(args[p.name])]));
      assert.equal(url.searchParams.has('confirm'), false);
      assert.equal(init.method, operation.method);
      assert.equal(init.body, args.body === undefined ? undefined : JSON.stringify(args.body));
      assert.equal(init.headers['Content-Type'], args.body === undefined ? undefined : 'application/json');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(args, original);
    });
  }
  assert.equal(calls.length, 44);
  assert.deepEqual([...new Set(calls.map(call => call.init.method))].sort(), ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
});

test('all writes are disabled by default and require confirm=true and a non-alias plan when enabled', async t => {
  const disabled = await connect(t);
  const enabled = await connect(t, { allowWrites: true });
  for (const operation of operations.filter(op => op.write)) {
    const args = sample(operation);
    await rejected(disabled.client, disabled.calls, operation, args, /Writes are disabled/);
    for (const confirm of [undefined, false, 'true', null]) {
      const invalid = { ...args, confirm };
      if (confirm === undefined) delete invalid.confirm;
      await rejected(enabled.client, enabled.calls, operation, invalid);
    }
    for (const plan_id of ['last-used', 'default']) {
      await rejected(enabled.client, enabled.calls, operation, { ...args, plan_id }, /concrete plan_id/);
    }
  }
  const read = operations.find(op => op.operationId === 'getPlanById');
  for (const plan_id of ['last-used', 'default']) {
    assert.notEqual((await disabled.client.callTool({ name: read.name, arguments: { plan_id } })).isError, true);
  }
});

test('inherited creation fields and all recent goal frequencies are accepted; nullable fields remain null', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  assert.deepEqual(spec.components.schemas.SaveCategory.properties.goal_frequency.enum, ['monthly', 'weekly', 'yearly']);
  for (const operationId of ['createCategory', 'updateCategory']) {
    const operation = operations.find(op => op.operationId === operationId);
    for (const goal_frequency of ['monthly', 'weekly', 'yearly']) {
      const args = sample(operation);
      args.body.category = { name: 'Groceries', category_group_id: id, note: null,
        goal_target: 0, goal_frequency, goal_needs_whole_amount: false };
      const result = await client.callTool({ name: operation.name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(decoded(result)));
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), args.body);
    }
  }
  const operation = operations.find(op => op.operationId === 'createTransaction');
  const args = sample(operation);
  args.body.transaction = { ...transaction, import_id: null, payee_id: null, payee_name: 'Test payee',
    category_id: null, memo: null, flag_color: null, subtransactions: [{ amount: -12500, memo: null, category_id: null }] };
  assert.notEqual((await client.callTool({ name: operation.name, arguments: args })).isError, true);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), args.body);
  assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).init.body).transaction, 'cleared'), false);
});

test('goal frequency semantic conflicts are rejected before HTTP, including explicit null target dates', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  for (const operation of operations.filter(op => ['createCategory', 'updateCategory'].includes(op.operationId))) {
    for (const fields of [{}, { goal_target: null }, { goal_target: 1000, goal_target_date: null },
      { goal_target: 1000, goal_target_date: '2027-01-01' }]) {
      const args = sample(operation);
      args.body.category = { name: 'Test', category_group_id: id, goal_frequency: 'monthly', ...fields };
      assert.equal(operation.validate(args), true, 'Exercise semantic validation, not schema rejection');
      await rejected(client, calls, operation, args, /goal_frequency requires goal_target/);
    }
    const args = sample(operation);
    args.body.category = { name: 'Test', category_group_id: id, goal_frequency: 'daily', goal_target: 1000 };
    await rejected(client, calls, operation, args);
  }
});

test('transaction creation wrapper is XOR, and import is bodyless', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  const operation = operations.find(op => op.operationId === 'createTransaction');
  for (const body of [{}, { transaction, transactions: [transaction] }, { transaction: null }, { transactions: null }]) {
    await rejected(client, calls, operation, { ...sample(operation), body });
  }
  for (const body of [{ transaction }, { transactions: [transaction, { ...transaction, amount: 0 }] }]) {
    assert.notEqual((await client.callTool({ name: operation.name, arguments: { ...sample(operation), body } })).isError, true);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), body);
  }
  const importer = operations.find(op => op.operationId === 'importTransactions');
  for (const body of [{}, null]) await rejected(client, calls, importer, { ...sample(importer), body });
  assert.notEqual((await client.callTool({ name: importer.name, arguments: sample(importer) })).isError, true);
  assert.equal(calls.at(-1).init.body, undefined);
  assert.equal(calls.at(-1).init.headers['Content-Type'], undefined);
});

test('bulk update requires exactly one nonempty identifier, treating null as absent', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  const operation = operations.find(op => op.operationId === 'updateTransactions');
  for (const identifiers of [{}, { id: null }, { import_id: null }, { id: null, import_id: null },
    { id: '' }, { import_id: '' }, { id: '', import_id: '' }, { id, import_id: 'test-import' },
    { id: '', import_id: 'test-import' }, { id, import_id: '' }]) {
    const args = { ...sample(operation), body: { transactions: [{ id, memo: 'valid first row' }, { ...identifiers, memo: null }] } };
    assert.equal(operation.validate(args), true);
    await rejected(client, calls, operation, args, /exactly one nonempty id or import_id/);
  }
  for (const identifiers of [{ id }, { import_id: 'test-import' }, { id: null, import_id: 'test-import' },
    { id, import_id: null }]) {
    const body = { transactions: [{ ...identifiers, memo: null, amount: 0 }] };
    assert.notEqual((await client.callTool({ name: operation.name, arguments: { ...sample(operation), body } })).isError, true);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), body);
  }
});

test('unknown fields at top level, wrapper, inherited body and array item boundaries never reach HTTP', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  for (const operation of operations) {
    await rejected(client, calls, operation, { ...sample(operation), unexpected: true });
    if (operation.tool.inputSchema.properties.body) {
      const args = sample(operation);
      args.body.unexpected = true;
      await rejected(client, calls, operation, args);
      const nested = sample(operation);
      for (const value of Object.values(nested.body)) {
        (Array.isArray(value) ? value[0] : value).unexpected = true;
      }
      await rejected(client, calls, operation, nested);
    }
  }
  const operation = operations.find(op => op.operationId === 'createTransaction');
  const args = sample(operation);
  args.body.transaction.subtransactions = [{ amount: 1000, unexpected: true }];
  await rejected(client, calls, operation, args);
});

test('missing required fields, unsafe integers, invalid UUIDs and invalid calendar dates never reach HTTP', async t => {
  const { client, calls } = await connect(t, { allowWrites: true });
  for (const operation of operations) {
    for (const key of operation.tool.inputSchema.required) {
      const args = sample(operation);
      delete args[key];
      await rejected(client, calls, operation, args);
    }
  }
  const create = operations.find(op => op.operationId === 'createTransaction');
  for (const fields of [{ amount: Number.MAX_SAFE_INTEGER + 1 }, { amount: Number.MIN_SAFE_INTEGER - 1 },
    { amount: 1.5 }, { amount: '1000' }, { account_id: 'not-a-uuid' }, { payee_id: 'not-a-uuid' },
    { category_id: 'not-a-uuid' }, { date: '2025-02-29' }, { date: '2026-13-01' }, { date: '2026-09-01T00:00:00Z' }]) {
    await rejected(client, calls, create, { ...sample(create), body: { transaction: { ...transaction, ...fields } } });
  }
  const list = operations.find(op => op.operationId === 'getTransactions');
  for (const fields of [{ since_date: '2026-02-30' }, { last_knowledge_of_server: Number.MAX_SAFE_INTEGER + 1 },
    { last_knowledge_of_server: '12' }, { type: 'not-a-type' }]) {
    await rejected(client, calls, list, { ...sample(list), ...fields });
  }
  for (const operation of operations.filter(op => op.parameters.some(p => p.name === 'month'))) {
    await rejected(client, calls, operation, { ...sample(operation), month: '2026-02-30' });
    assert.notEqual((await client.callTool({ name: operation.name, arguments: { ...sample(operation), month: '2024-02-29' } })).isError, true);
  }
  const category = operations.find(op => op.operationId === 'createCategory');
  for (const key of ['name', 'category_group_id']) {
    const args = sample(category);
    delete args.body.category[key];
    await rejected(client, calls, category, args);
  }
  for (const amount of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0]) {
    assert.notEqual((await client.callTool({ name: create.name, arguments: { ...sample(create), body: { transaction: { ...transaction, amount } } } })).isError, true);
  }
});

test('unknown tools return MCP errors and parameterless tools accept omitted arguments', async t => {
  const { client, calls } = await connect(t);
  const unknown = await client.callTool({ name: 'ynab_nonexistent', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.deepEqual(decoded(unknown), { error: 'Unknown YNAB tool.' });
  assert.equal(calls.length, 0);
  assert.notEqual((await client.callTool({ name: 'ynab_get_user' })).isError, true);
});

test('API errors preserve the readable message and nested details in MCP results', async t => {
  const error = new ApiError('Upstream failure', { status: 404, error: { id: 'not_found' } });
  const { client } = await connect(t, { api: { request: async () => { throw error; } } });
  const result = await client.callTool({ name: 'ynab_get_user', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(decoded(result), { error: 'Upstream failure', details: { status: 404, error: { id: 'not_found' } } });
});

test('unexpected failures use sanitized MCP error results', async t => {
  const { client } = await connect(t, { api: { request: async () => { throw new Error('private internal details'); } } });
  const result = await client.callTool({ name: 'ynab_get_user', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(decoded(result), { error: 'Unexpected YNAB request failure. For writes, verify state before retrying.' });
  assert.equal(JSON.stringify(result).includes('private internal details'), false);
});

test('write 5xx errors retain uncertainty warnings and redacted details through MCP', async t => {
  const { client, calls } = await connect(t, { allowWrites: true, fetchImpl: async () =>
    Response.json({ error: { id: 'upstream', detail: 'echo fake-server-test-token' } }, { status: 503 }) });
  const operation = operations.find(op => op.operationId === 'importTransactions');
  const result = await client.callTool({ name: operation.name, arguments: sample(operation) });
  assert.equal(result.isError, true);
  assert.deepEqual(decoded(result), {
    error: 'YNAB API error (HTTP 503). Outcome uncertain; verify state before retrying.',
    details: { status: 503, error: { id: 'upstream', detail: 'echo [REDACTED]' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes('fake-server-test-token'), false);
});

test('server-side write timeout delivers an uncertain-outcome MCP result without cancelling the call', { timeout: 5000 }, async t => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let calls = 0;
  let signal;
  const api = new YnabApi('fake-timeout-token', { timeoutMs: 10, fetchImpl: async (url, init) => {
    calls++;
    signal = init.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const { client } = await connect(t, { allowWrites: true, api });
  const operation = operations.find(op => op.operationId === 'importTransactions');
  const result = await client.callTool({ name: operation.name, arguments: sample(operation) });
  assert.equal(result.isError, true);
  assert.deepEqual(decoded(result), {
    error: 'YNAB request failed or timed out. The mutation may have succeeded; read the affected data before retrying.',
    details: {},
  });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('MCP initialization instructions and guide resource agree', async t => {
  const { client, calls } = await connect(t);
  assert.equal(client.getInstructions(), guide);
  const { resources } = await client.listResources();
  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, 'ynab://guide');
  assert.deepEqual((await client.readResource({ uri: 'ynab://guide' })).contents,
    [{ uri: 'ynab://guide', mimeType: 'text/plain', text: guide }]);
  await assert.rejects(client.readResource({ uri: 'ynab://missing' }), /Unknown resource/);
  assert.equal(calls.length, 0);
});

test('MCP client cancellation propagates through the server to the mocked HTTP request', { timeout: 5000 }, async t => {
  let started;
  let aborted;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const requestAborted = new Promise(resolve => { aborted = resolve; });
  const { client, calls } = await connect(t, { fetchImpl: async (url, init) => {
    started();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted();
        reject(init.signal.reason);
      }, { once: true });
    });
  } });
  const controller = new AbortController();
  const pending = client.callTool({ name: 'ynab_get_user', arguments: {} }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(pending, /test cancellation/);
  await requestStarted;
  controller.abort(new Error('test cancellation'));
  await rejection;
  await requestAborted;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('cancelled writes can already be committed and the SDK suppresses their uncertainty result', { timeout: 5000 }, async t => {
  let started;
  let aborted;
  let committed = false;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const requestAborted = new Promise(resolve => { aborted = resolve; });
  const { client, calls, serverTransport } = await connect(t, { allowWrites: true, fetchImpl: async (url, init) => {
    committed = true;
    started();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted();
        reject(init.signal.reason);
      }, { once: true });
    });
  } });
  const messages = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async message => { messages.push(message); await send(message); };
  const operation = operations.find(op => op.operationId === 'importTransactions');
  const controller = new AbortController();
  const pending = client.callTool({ name: operation.name, arguments: sample(operation) }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(pending, /test write cancellation/);
  await requestStarted;
  controller.abort(new Error('test write cancellation'));
  await rejection;
  await requestAborted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(committed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
  // MCP cancellation discards the handler's result. No warning does not mean rollback;
  // clients must verify state before retrying a cancelled write.
  assert.equal(messages.filter(message => Object.hasOwn(message, 'id')).length, 0);
});
