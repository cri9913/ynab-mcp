import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'ynab-read-only-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { ...process.env, YNAB_ALLOW_WRITES: 'false' },
    stderr: 'pipe',
  }));
  const { tools } = await client.listTools();
  const result = await client.callTool({ name: 'ynab_get_user', arguments: {} });
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  if (result.isError || data.status !== 200 || !data.response?.data?.user?.id) {
    throw new Error('Read-only authentication check failed. No response data printed.');
  }
  console.log(`PASS: stdio MCP handshake, ${tools.length} tools, and authenticated GET /user. No personal data printed; no writes performed.`);
} finally {
  await client.close();
}
