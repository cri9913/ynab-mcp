import { operations, spec } from '../src/catalog.js';

console.log(`YNAB API ${spec.info.version}: ${operations.length} validated MCP tools (${operations.filter(operation => !operation.write).length} read, ${operations.filter(operation => operation.write).length} write).`);
for (const operation of operations) console.log(`${operation.name}\t${operation.method} ${operation.path}`);
