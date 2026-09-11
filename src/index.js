import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadToken } from './auth.js';
import { YnabApi } from './api.js';
import { createServer } from './server.js';

try {
  const token = await loadToken();
  const server = createServer(new YnabApi(token), { allowWrites: process.env.YNAB_ALLOW_WRITES === 'true' });
  await server.connect(new StdioServerTransport());
} catch {
  console.error('MCP for YNAB could not start. Check dependencies and the local credential; no credential details are logged.');
  process.exitCode = 1;
}
