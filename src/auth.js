import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** execFileImpl uses Node's execFile(file, args, options, callback) signature. */
export async function loadToken({
  env = process.env,
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  let token = env.YNAB_ACCESS_TOKEN;

  if (token === undefined) {
    if (platform !== 'win32') {
      throw new Error('Set YNAB_ACCESS_TOKEN on this platform.');
    }

    const root = env.SystemRoot;
    if (typeof root !== 'string' || !win32.isAbsolute(root)
      || win32.parse(root).root.length <= 1) {
      throw new Error('An absolute SystemRoot is required to load YNAB credentials.');
    }

    try {
      token = await new Promise((resolve, reject) => {
        execFileImpl(
          win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          [
            '-NoProfile', '-NonInteractive', '-File',
            fileURLToPath(new URL('../scripts/credential.ps1', import.meta.url)),
            '-Action', 'Get',
          ],
          {
            env,
            shell: false,
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
          (error, stdout) => error ? reject(error) : resolve(stdout),
        );
      });
    } catch {
      // Child errors can contain stdout, stderr, and the full command line.
      throw new Error('Unable to load YNAB credentials.');
    }
  }

  if (typeof token !== 'string' || token.trim().length === 0
    || /[\r\n\u2028\u2029]/u.test(token)) {
    throw new Error('YNAB access token must be nonempty and contain no newlines.');
  }

  return token;
}
