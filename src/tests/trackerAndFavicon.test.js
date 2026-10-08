import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sourceRoot } from './harness.js';

const root = path.resolve(sourceRoot, '..');
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

describe('external tracker URLs', () => {
  test('tracker URLs live only in src/config/apsrtcTrackers.ts (components never hardcode them)', () => {
    const offenders = [];
    for (const file of walk(sourceRoot).filter(f => /\.(ts|tsx)$/.test(f))) {
      if (file.endsWith(path.join('config', 'apsrtcTrackers.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      if (/abhibus\.com|redbus\.in|apsrtclivetrack\.com/i.test(text)) offenders.push(path.relative(root, file));
    }
    assert.deepEqual(offenders, []);
  });

  test('the registry holds exactly the three verified destinations, none with a query string', () => {
    const text = readFileSync(path.join(sourceRoot, 'config', 'apsrtcTrackers.ts'), 'utf8');
    const urls = [...text.matchAll(/url: '(https:\/\/[^']+)'/g)].map(match => match[1]);
    assert.deepEqual(urls, ['https://apsrtclivetrack.com/', 'https://www.redbus.in/live-tracking/apsrtc/', 'https://www.abhibus.com/apsrtc-live-track/service-no']);
  });
});

describe('favicon', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');

  test('index.html links an SVG favicon that exists in public/ (served by Vite and copied to the build)', () => {
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
    assert.ok(existsSync(path.join(root, 'public', 'favicon.svg')));
  });

  test('it is a text-free RouteConnect pin in the brand colour with no external branding or scripts', () => {
    const svg = readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8');
    assert.match(svg, /<linearGradient/);
    assert.match(svg, /#E5A93D/i, 'the UI highlight gold (--color-highlight)');
    assert.match(svg, /#1F2933/i, 'the UI charcoal (--color-dark)');
    assert.doesNotMatch(svg, /#22B59A|#0B5A4B|#146B5B/i, 'no green');
    assert.doesNotMatch(svg, /<text|<image|<script|href=|abhibus|google|uber|ola|rapido|apsrtc/i);
    assert.match(svg, /viewBox="0 0 32 32"/);
  });
});
