import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
const missing = [];

for (const dep of deps) {
  try {
    require.resolve(dep);
  } catch {
    missing.push(dep);
  }
}

if (missing.length) {
  console.error(`XOFT dependency check failed. Missing: ${missing.join(', ')}`);
  console.error('Run: npm ci --ignore-scripts --no-audit --no-fund');
  process.exit(1);
}

console.log(`XOFT dependency check passed (${deps.length}/${deps.length} runtime packages resolvable).`);
