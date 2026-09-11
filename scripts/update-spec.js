import { writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

const source = 'https://api.ynab.com/papi/open_api_spec.yaml';
const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Specification download failed: HTTP ${response.status}`);
const spec = parse(await response.text());
if (!spec.openapi?.startsWith('3.1.') || !spec.paths || !spec.components?.schemas) {
  throw new Error('Unexpected upstream specification format; review before updating.');
}
await writeFile(new URL('../spec/openapi.json', import.meta.url), `${JSON.stringify(spec, null, 2)}\n`);
console.error(`Pinned YNAB API ${spec.info.version} from ${source}. Run npm test and review the diff.`);
