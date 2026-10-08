// Test harness for the TypeScript/React frontend modules: bundles an entry with esbuild (already a Vite dependency)
// and loads it in Node, so components can be rendered to static HTML with react-dom/server without a browser.
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

export function bundle(entrySource, name = 'bundle') {
  const result = buildSync({
    stdin: { contents: entrySource, resolveDir: path.join(root, 'src'), loader: 'tsx', sourcefile: `${name}.tsx` },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' }
  });
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'rc-ui-')), `${name}.cjs`);
  writeFileSync(file, result.outputFiles[0].text);
  return require(file);
}

export const sourceRoot = path.join(root, 'src');
