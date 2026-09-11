import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, YnabApi } from '../src/api.js';

const token = 'fake-api-test-secret';
const read = { method: 'GET', path: '/plans/{plan_id}/transactions', parameters: [], write: false };
const write = { ...read, method: 'POST', write: true };
const args = { plan_id: 'test-plan' };

function fixture(options = {}) {
  const calls = [];
  const { fetchImpl = async () => Response.json({ data: { ok: true } }), ...rest } = options;
  const api = new YnabApi(token, { ...rest, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return fetchImpl(url, init);
  } });
  return { api, calls };
}

test('429 headers enforce cooldown even when the response body fails', async () => {
  const { api, calls } = fixture({ now: () => 0, fetchImpl: async () => ({
    status: 429,
    headers: new Headers({ 'retry-after': '60' }),
    text: async () => { throw new Error('Broken response stream'); },
  }) });
  await assert.rejects(api.request(read, args), /failed or timed out/);
  await assert.rejects(api.request(read, args), error => error.details.status === 429);
  assert.equal(calls.length, 1);
});

test('API credentials are validated without leaking supplied values', () => {
  for (const credential of [undefined, null, 42, '', ' ', ` ${token}`, `${token}\n`, `${token}\tpart`]) {
    assert.throws(() => new YnabApi(credential, { fetchImpl: () => assert.fail('No HTTP') }), error => {
      assert.equal(error.message, 'Invalid YNAB credential');
      assert.equal(error.stack.includes(token), false);
      return true;
    });
  }
});

test('origin is pinned, path segments are encoded once, and requests use bearer auth and redirect:error', async () => {
  const { api, calls } = fixture();
  for (const plan_id of ['test-plan', 'name:with@symbols', 'caf\u00e9', '%2e%2e', '%2Fexample.com', 'a&b=1']) {
    await api.request(read, { plan_id, confirm: true, base_url: 'https://attacker.invalid' });
    const { url, init } = calls.at(-1);
    assert.equal(url.origin, 'https://api.ynab.com');
    assert.equal(url.pathname, `/v1/plans/${encodeURIComponent(plan_id)}/transactions`);
    assert.equal(url.search, '');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
  }
});

test('dot, slash, URL and control-character path injection fails before fetch', async () => {
  const { api, calls } = fixture();
  for (const plan_id of [undefined, null, 1, '', '.', '..', '../user', 'a/b', 'a\\b', '//attacker.invalid',
    'https://attacker.invalid', 'a?query', 'a#fragment', 'a b', 'a\t', 'a\n', 'a\0']) {
    await assert.rejects(api.request(read, { plan_id }), { message: 'Invalid API path parameter.' });
  }
  for (const path of ['/../user', '/../../user']) {
    await assert.rejects(api.request({ ...read, path }, {}), { message: 'Invalid API destination.' });
  }
  assert.equal(calls.length, 0);
});

test('query dates, boolean false/true and delta zero are encoded; omitted and undeclared fields are excluded', async () => {
  const { api, calls } = fixture();
  const operation = { ...read, parameters: ['since_date', 'include_accounts', 'last_knowledge_of_server', 'type']
    .map(name => ({ name, in: 'query' })) };
  for (const include_accounts of [false, true]) {
    await api.request(operation, { ...args, since_date: '2024-02-29', include_accounts,
      last_knowledge_of_server: 0, type: 'a&b + c', ignored: 'not sent' });
    const url = calls.at(-1).url;
    assert.equal(url.search, `?since_date=2024-02-29&include_accounts=${include_accounts}&last_knowledge_of_server=0&type=a%26b+%2B+c`);
    assert.equal(url.searchParams.get('type'), 'a&b + c');
  }
  await api.request(operation, { ...args, since_date: undefined });
  assert.equal(calls.at(-1).url.search, '');
});

test('POST, PUT, PATCH and DELETE preserve JSON null, false and zero; import POST omits body and content type', async () => {
  const { api, calls } = fixture();
  const body = { transaction: { memo: null, approved: false, amount: 0, omitted: undefined } };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await api.request({ ...write, method }, { ...args, body, confirm: true });
    const { init } = calls.at(-1);
    assert.equal(init.method, method);
    assert.equal(init.body, '{"transaction":{"memo":null,"approved":false,"amount":0}}');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
  await api.request({ ...write, path: '/plans/{plan_id}/transactions/import' }, args);
  assert.equal(calls.at(-1).init.method, 'POST');
  assert.equal(calls.at(-1).init.body, undefined);
  assert.equal(calls.at(-1).init.headers['Content-Type'], undefined);
});

test('transport, response-read and redirect failures are sanitized and never retried, including ambiguous writes', async t => {
  for (const operation of [read, write]) {
    for (const phase of ['fetch', 'text', 'redirect']) {
      await t.test(`${operation.method} ${phase}`, async () => {
        const { api, calls } = fixture({ fetchImpl: async (url, init) => {
          assert.equal(init.redirect, 'error');
          const error = new Error(`${phase}: ${token}`);
          if (phase === 'text') return { text: async () => { throw error; } };
          throw error;
        } });
        await assert.rejects(api.request(operation, args), error => {
          assert.ok(error instanceof ApiError);
          assert.match(error.message, /failed or timed out/);
          assert.equal(/mutation may have succeeded/.test(error.message), operation.write);
          assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
          assert.equal(error.cause, undefined);
          assert.deepEqual(error.details, {});
          return true;
        });
        assert.equal(calls.length, 1);
      });
    }
  }
});

test('successful status, rate header, JSON null and empty responses are preserved', async () => {
  for (const [status, text, expected] of [[200, '{"data":{"value":null}}', { data: { value: null } }],
    [201, '{"data":{"id":"created"}}', { data: { id: 'created' } }], [200, 'null', null], [204, null, null], [200, '', null]]) {
    const { api, calls } = fixture({ fetchImpl: async () => new Response(text, { status, headers: { 'x-rate-limit': '17/200' } }) });
    assert.deepEqual(await api.request(read, args), { status, rate_limit: '17/200', response: expected });
    assert.equal(calls.length, 1);
  }
});

test('upstream errors preserve HTTP status and error details without retrying or exposing tokens', async t => {
  for (const operation of [read, write]) {
    for (const status of [301, 400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      await t.test(`${operation.method} ${status}`, async () => {
        const { api, calls } = fixture({ fetchImpl: async () => Response.json({ error: { id: 'upstream', detail: `echo ${token}` } },
          { status, headers: { 'retry-after': '2' } }) });
        await assert.rejects(api.request(operation, args), error => {
          assert.ok(error instanceof ApiError);
          assert.deepEqual(error.details, { status, error: { id: 'upstream', detail: 'echo [REDACTED]' }, retry_after: '2' });
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          assert.equal(/Outcome uncertain/.test(error.message), operation.write && status >= 500);
          assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
          return true;
        });
        assert.equal(calls.length, 1);
      });
    }
  }
});

test('missing upstream error object is represented as null, including null and empty response bodies', async () => {
  for (const text of ['null', '', '{}']) {
    const { api } = fixture({ fetchImpl: async () => new Response(text, { status: 404 }) });
    await assert.rejects(api.request(read, args), error => {
      assert.deepEqual(error.details, { status: 404, error: null });
      return true;
    });
  }
});

test('non-JSON responses report status, never echo content, and warn before retrying writes', async () => {
  for (const operation of [read, write]) {
    for (const status of [200, 502]) {
      const { api, calls } = fixture({ fetchImpl: async () => new Response(`<html>${token}</html>`, { status }) });
      await assert.rejects(api.request(operation, args), error => {
        assert.ok(error instanceof ApiError);
        assert.deepEqual(error.details, { status });
        assert.match(error.message, /non-JSON response/);
        assert.equal(/Verify state before retrying/.test(error.message), operation.write);
        assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('token redaction covers successful nested values, keys and rate-limit headers', async () => {
  const { api } = fixture({ fetchImpl: async () => Response.json({ [token]: [token, { memo: `before ${token} after ${token}` }], value: null },
    { headers: { 'x-rate-limit': `1/200 ${token}` } }) });
  const result = await api.request(read, args);
  assert.deepEqual(result, { status: 200, rate_limit: '1/200 [REDACTED]',
    response: { '[REDACTED]': ['[REDACTED]', { memo: 'before [REDACTED] after [REDACTED]' }], value: null } });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('local rate limiter permits 200 per rolling hour and expires each request at its exact boundary', async () => {
  let now = 10_000;
  const { api, calls } = fixture({ now: () => now });
  for (let index = 0; index < 100; index++) await api.request(read, args);
  now += 1000;
  for (let index = 0; index < 100; index++) await api.request(write, args);
  await assert.rejects(api.request(read, args), error => error instanceof ApiError && error.details.status === 429);
  assert.equal(calls.length, 200);
  now = 10_000 + 3_600_000 - 1;
  await assert.rejects(api.request(read, args), /rate limit/);
  now++;
  for (let index = 0; index < 100; index++) await api.request(read, args);
  await assert.rejects(api.request(read, args), /rate limit/);
  assert.equal(calls.length, 300);
  now += 1000;
  await api.request(read, args);
  assert.equal(calls.length, 301);
});

test('failed transport attempts consume the local quota; rejected paths do not', async () => {
  const { api, calls } = fixture({ now: () => 0, fetchImpl: async () => { throw new Error('offline'); } });
  for (let index = 0; index < 201; index++) await assert.rejects(api.request(read, { plan_id: '..' }), /path parameter/);
  for (let index = 0; index < 200; index++) await assert.rejects(api.request(read, args), /failed or timed out/);
  await assert.rejects(api.request(read, args), /rate limit/);
  assert.equal(calls.length, 200);
});

test('429 cooldown honors seconds, HTTP dates, minimum delay and fallback rolling hour', async t => {
  const start = Date.UTC(2026, 8, 10);
  for (const [label, retryAfter, delay] of [['seconds', '2', 2000], ['zero', '0', 1000],
    ['date', new Date(start + 5000).toUTCString(), 5000], ['past date', new Date(start - 5000).toUTCString(), 1000],
    ['missing', undefined, 3_600_000], ['invalid', 'not-a-delay', 3_600_000]]) {
    await t.test(label, async () => {
      let now = start;
      let count = 0;
      const { api, calls } = fixture({ now: () => now, fetchImpl: async () => ++count === 1
        ? Response.json({ error: { id: 'rate_limit' } }, { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
        : Response.json({ data: {} }) });
      await assert.rejects(api.request(read, args), error => error.details.status === 429);
      await assert.rejects(api.request(read, args), /rate limit/);
      now = start + delay - 1;
      await assert.rejects(api.request(read, args), /rate limit/);
      assert.equal(calls.length, 1);
      now++;
      await api.request(read, args);
      assert.equal(calls.length, 2);
    });
  }
});

test('slow 429 responses start relative cooldowns on receipt and preserve absolute HTTP dates', async t => {
  const start = Date.UTC(2026, 8, 10);
  const receivedAt = start + 5000;
  for (const [label, retryAfter, delay] of [['seconds', '2', 2000], ['zero', '0', 1000],
    ['date', new Date(receivedAt + 5000).toUTCString(), 5000],
    ['expired date', new Date(start + 2000).toUTCString(), 1000],
    ['missing', undefined, 3_600_000], ['invalid', 'not-a-delay', 3_600_000]]) {
    await t.test(label, async () => {
      let now = start;
      let count = 0;
      const { api, calls } = fixture({ now: () => now, fetchImpl: async () => {
        if (++count !== 1) return Response.json({ data: {} });
        now = receivedAt;
        return Response.json({ error: { id: 'rate_limit' } },
          { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });
      } });
      await assert.rejects(api.request(read, args), error => error.details.status === 429);
      await assert.rejects(api.request(read, args), /rate limit/);
      now = receivedAt + delay - 1;
      await assert.rejects(api.request(read, args), /rate limit/);
      assert.equal(calls.length, 1);
      now++;
      await api.request(read, args);
      assert.equal(calls.length, 2);
    });
  }
});

test('overlapping 429 responses retain the longest cooldown deadline', async t => {
  for (const delays of [[10, 2], [2, 10]]) {
    await t.test(`Retry-After order ${delays.join(', ')}`, async () => {
      let now = 0;
      const responses = [];
      const { api, calls } = fixture({ now: () => now, fetchImpl: () => calls.length <= 2
        ? new Promise(resolve => responses.push(resolve)) : Response.json({ data: {} }) });
      const first = assert.rejects(api.request(read, args), error => error.details.status === 429);
      const second = assert.rejects(api.request(read, args), error => error.details.status === 429);
      assert.equal(responses.length, 2);
      now = 1000;
      responses[0](Response.json({ error: {} }, { status: 429, headers: { 'retry-after': String(delays[0]) } }));
      await first;
      now = 2000;
      responses[1](Response.json({ error: {} }, { status: 429, headers: { 'retry-after': String(delays[1]) } }));
      await second;
      now = Math.max(1000 + delays[0] * 1000, 2000 + delays[1] * 1000) - 1;
      await assert.rejects(api.request(read, args), /rate limit/);
      assert.equal(calls.length, 2);
      now++;
      await api.request(read, args);
      assert.equal(calls.length, 3);
    });
  }
});

test('429 with a non-JSON body still starts the cooldown', async () => {
  const { api, calls } = fixture({ now: () => 0, fetchImpl: async () => new Response('not json', { status: 429 }) });
  await assert.rejects(api.request(read, args), /non-JSON/);
  await assert.rejects(api.request(read, args), /rate limit/);
  assert.equal(calls.length, 1);
});

test('caller cancellation and timeout abort fetch and response reads without leaking reasons or retrying', async t => {
  // AbortSignal.timeout uses an unref'ed timer; keep this isolated test alive until it fires.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  for (const operation of [read, write]) {
    for (const phase of ['fetch', 'text']) {
      for (const mode of ['cancel', 'pre-aborted', 'timeout', 'timeout-with-signal']) {
        await t.test(`${operation.method} ${phase} ${mode}`, async () => {
          const controller = new AbortController();
          if (mode === 'pre-aborted') controller.abort(new Error(token));
          const { api, calls } = fixture({ timeoutMs: mode.startsWith('timeout') ? 10 : 1000, fetchImpl: async (url, init) => {
            const wait = () => new Promise((resolve, reject) => {
              if (init.signal.aborted) reject(init.signal.reason);
              else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            });
            if (mode === 'cancel') queueMicrotask(() => controller.abort(new Error(token)));
            return phase === 'fetch' ? wait() : { text: wait };
          } });
          await assert.rejects(api.request(operation, args, mode === 'timeout' ? undefined : controller.signal), error => {
            assert.ok(error instanceof ApiError);
            assert.match(error.message, /failed or timed out/);
            assert.equal(/mutation may have succeeded/.test(error.message), operation.write);
            assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
            return true;
          });
          assert.equal(calls.length, 1);
          assert.equal(calls[0].init.signal.aborted, true);
          if (mode === 'timeout-with-signal') assert.equal(controller.signal.aborted, false);
        });
      }
    }
  }
});
