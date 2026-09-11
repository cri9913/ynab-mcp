import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadToken } from '../src/auth.js';

test('Windows DPAPI credentials use isolated fabricated fixtures', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ynab-dpapi-test-'));
  try {
    const fakeToken = 'fabricated-dpapi-test-token-not-a-credential';
    const env = { ...process.env };
    // Windows environment variable names are case-insensitive.
    for (const key of Object.keys(env)) {
      if (/^YNAB_(ACCESS_TOKEN|SECRET_PATH)$/i.test(key)) delete env[key];
    }
    env.YNAB_SECRET_PATH = join(directory, 'fake secret.xml');
    env.YNAB_TEST_TOKEN = fakeToken;
    env.YNAB_TEST_WRONG_FORMAT_PATH = join(directory, 'wrong format.xml');

    await promisify(execFile)(
      join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME/Modules"
$secure = ConvertTo-SecureString -String $env:YNAB_TEST_TOKEN -AsPlainText -Force
try {
    $secure | Export-Clixml -LiteralPath $env:YNAB_SECRET_PATH
    $env:YNAB_TEST_TOKEN | Export-Clixml -LiteralPath $env:YNAB_TEST_WRONG_FORMAT_PATH
} finally {
    $secure.Dispose()
}
`],
      {
        env,
        shell: false,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    delete env.YNAB_TEST_TOKEN;

    await t.test('SecureString Export-Clixml round trip returns the exact token', async () => {
      assert.equal(await loadToken({ env }), fakeToken);
    });

    const corruptPath = join(directory, 'corrupt.xml');
    await writeFile(corruptPath, `<broken>${fakeToken}`, 'utf8');
    for (const [name, secretPath] of [
      ['corrupt XML', corruptPath],
      ['wrong-format CLIXML', env.YNAB_TEST_WRONG_FORMAT_PATH],
    ]) {
      await t.test(`${name} fails without disclosing fixture data`, async () => {
        await assert.rejects(loadToken({
          env: { ...env, YNAB_SECRET_PATH: secretPath },
        }), (error) => {
          assert.equal(error.message, 'Unable to load YNAB credentials.');
          for (const key of ['cause', 'stdout', 'stderr', 'cmd']) {
            assert.equal(error[key], undefined);
          }
          for (const value of [fakeToken, secretPath, directory]) {
            assert.equal(error.stack.includes(value), false);
            assert.equal(JSON.stringify(error).includes(value), false);
          }
          return true;
        });
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
