import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Node ESM wants explicit file extensions; Metro and tsc do not. For the *test* runner only,
// resolve extensionless relative specifiers by trying `x.ts`, `x.tsx`, ..., `x/index.ts`, ...
// Loaded automatically via `--import` in the `test` script (see package.json).
const EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && path.extname(specifier) === '') {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : path.join(process.cwd(), 'x.js');
      const base = path.resolve(path.dirname(parent), specifier);
      const candidates = [
        ...EXTS.map((ext) => base + ext),
        ...EXTS.map((ext) => path.join(base, 'index' + ext)),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
