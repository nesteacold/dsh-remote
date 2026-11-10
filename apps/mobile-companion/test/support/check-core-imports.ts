import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// `npm run check:core` — Part A constitution guard for src/core: the pure-TS core must not
// import react-native, expo, or Node built-ins, so it runs unchanged in Node tests and in the
// app bundle (production transports/secure store live in src/platform, Phase 4).

// This file runs with `--import tsx`, which transpiles to CommonJS: `__dirname` is the
// supporting folder, so the repository app root is two levels up.
const ROOT = path.resolve(__dirname, '..', '..');
const CORE_DIR = path.join(ROOT, 'src', 'core');

const FORBIDDEN = [
  { pattern: /from\s+['"]react-native['"]/g, label: 'react-native' },
  { pattern: /from\s+['"]expo[^'"]*['"]/g, label: 'expo' },
  { pattern: /from\s+['"]node:[^'"]+['"]/g, label: 'node built-in' },
  { pattern: /require\(\s*['"](node:|react-native|expo)/g, label: 'require() of a runtime module' },
  // The core may import only the contract package and its own modules: platform adapters
  // (secure store, biometrics, notifications) live one layer up and must never leak in.
  { pattern: /from\s+['"][^'"]*\/platform(\/|['"])/g, label: 'src/platform (use an injected adapter)' },
  { pattern: /from\s+['"]\.\.\/app-state['"]/g, label: 'src/app-state (one-way dependency)' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const violations: string[] = [];
for (const file of walk(CORE_DIR)) {
  const text = readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      violations.push(`${path.relative(ROOT, file)}: ${rule.label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('src/core must stay free of react-native / expo / node imports:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('src/core import check: OK (no react-native, expo or node imports)');
