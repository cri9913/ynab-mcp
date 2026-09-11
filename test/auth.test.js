import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadToken } from '../src/auth.js';

const fakeToken = 'non-secret-test-token';
const windowsEnv = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Test\\AppData\\Local' };
const noExec = () => assert.fail('Subprocess must not be invoked');

test('environment token is preferred on every platform, without requiring SystemRoot', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.equal(await loadToken({
      env: { YNAB_ACCESS_TOKEN: fakeToken, YNAB_SECRET_PATH: 'unused.xml' },
      platform,
      execFileImpl: noExec,
    }), fakeToken);
  }
});

test('invalid environment tokens fail without fallback or value disclosure', async () => {
  for (const token of ['', ' \t ', '\n', `${fakeToken}\n`, `${fakeToken}\r`,
    `first\n${fakeToken}`, `${fakeToken}\u2028`, `${fakeToken}\u2029`, null, 123]) {
    await assert.rejects(loadToken({
      env: { ...windowsEnv, YNAB_ACCESS_TOKEN: token },
      platform: 'win32',
      execFileImpl: noExec,
    }), (error) => {
      assert.equal(error.message, 'YNAB access token must be nonempty and contain no newlines.');
      assert.equal(error.stack.includes(fakeToken), false);
      return true;
    });
  }
});

test('missing token on non-Windows requires environment configuration', async () => {
  for (const platform of ['linux', 'darwin']) {
    await assert.rejects(loadToken({
      env: { YNAB_SECRET_PATH: 'unused.xml' },
      platform,
      execFileImpl: noExec,
    }), { message: 'Set YNAB_ACCESS_TOKEN on this platform.' });
  }
});

test('Windows requires an absolute SystemRoot rather than executable PATH lookup', async () => {
  for (const SystemRoot of [undefined, '', 'Windows', 'C:Windows', '\\Windows', 123]) {
    await assert.rejects(loadToken({
      env: { SystemRoot },
      platform: 'win32',
      execFileImpl: noExec,
    }), { message: 'An absolute SystemRoot is required to load YNAB credentials.' });
  }
});

test('Windows captures the bundled script output with bounded, shell-free execution', async () => {
  for (const customPath of [undefined, 'C:\\Test Secrets\\custom.xml']) {
    const env = { ...windowsEnv };
    if (customPath !== undefined) env.YNAB_SECRET_PATH = customPath;
    let calls = 0;
    const token = await loadToken({
      env,
      platform: 'win32',
      execFileImpl(file, args, options, callback) {
        calls += 1;
        assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.deepEqual(args, [
          '-NoProfile', '-NonInteractive', '-File',
          fileURLToPath(new URL('../scripts/credential.ps1', import.meta.url)),
          '-Action', 'Get',
        ]);
        assert.deepEqual(options, {
          env,
          shell: false,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        assert.equal(args.includes(fakeToken), false);
        if (customPath !== undefined) assert.equal(args.includes(customPath), false);
        queueMicrotask(() => callback(null, fakeToken, 'ignored non-secret stderr'));
      },
    });
    assert.equal(calls, 1);
    assert.equal(token, fakeToken);
  }
});

test('invalid child stdout is rejected rather than trimmed or returned', async () => {
  for (const stdout of ['', ' \t ', `${fakeToken}\n`, `${fakeToken}\r\n`,
    `${fakeToken}\u2028`, `${fakeToken}\u2029`, undefined, Buffer.from(fakeToken)]) {
    await assert.rejects(loadToken({
      env: windowsEnv,
      platform: 'win32',
      execFileImpl(file, args, options, callback) {
        callback(null, stdout, fakeToken);
      },
    }), { message: 'YNAB access token must be nonempty and contain no newlines.' });
  }
});

test('child failures, timeout, buffer overflow, and synchronous throws are sanitized', async () => {
  for (const mode of ['callback', 'timeout', 'buffer', 'throw']) {
    const failure = new Error(`child stderr or command: ${fakeToken}`);
    failure.stdout = fakeToken;
    failure.stderr = fakeToken;
    if (mode === 'timeout') failure.killed = true;
    if (mode === 'buffer') failure.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

    await assert.rejects(loadToken({
      env: windowsEnv,
      platform: 'win32',
      execFileImpl(file, args, options, callback) {
        if (mode === 'throw') throw failure;
        callback(failure, fakeToken, fakeToken);
      },
    }), (error) => {
      assert.equal(error.message, 'Unable to load YNAB credentials.');
      assert.equal(error.cause, undefined);
      assert.equal(error.stdout, undefined);
      assert.equal(error.stderr, undefined);
      assert.equal(error.stack.includes(fakeToken), false);
      assert.equal(JSON.stringify(error).includes(fakeToken), false);
      return true;
    });
  }
});
