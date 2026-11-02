// Copies the vendored team DDL next to the compiled migrations (tsc does not copy non-TypeScript files).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/database/team/wms_schema.sql', import.meta.url));
const target = fileURLToPath(new URL('../dist/database/team/wms_schema.sql', import.meta.url));
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target);
