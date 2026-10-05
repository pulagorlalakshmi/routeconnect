// Small helpers shared by the transit command-line scripts.
import fs from 'fs';
import path from 'path';

// --key value  /  --flag   ->  { key: 'value', flag: true }
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function metaPathFor(zipPath) {
  return `${zipPath}.meta.json`;
}

export function readMeta(zipPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPathFor(zipPath), 'utf8'));
  } catch {
    return null;
  }
}

export function relativeToCwd(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}
