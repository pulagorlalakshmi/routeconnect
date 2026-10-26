// Place suggestions from across India: what each kind of suggestion says about itself. TEST FIXTURES ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const ui = bundle(`export { suggestionSubtitle, SUGGESTION_MESSAGES } from './components/LocationInput';`, 'nationwideui');

test('a bus place shows its stops and services; a city, town or railway station says what it is', () => {
  const base = { id: 'x', name: 'X', lat: 0, lon: 0, stopCount: 2, services: 40, matchedBy: 'exact' };
  assert.equal(ui.suggestionSubtitle(base), '2 stops · 40 services');
  assert.equal(ui.suggestionSubtitle({ ...base, kind: 'bus_stop' }), '2 stops · 40 services');
  assert.equal(ui.suggestionSubtitle({ ...base, kind: 'city', stopCount: 0, services: 0 }), 'City · trains from nearby stations');
  assert.equal(ui.suggestionSubtitle({ ...base, kind: 'town', stopCount: 0, services: 0 }), 'Town · trains from nearby stations');
  assert.equal(ui.suggestionSubtitle({ ...base, kind: 'station', code: 'MAS', stopCount: 0, services: 0 }), 'Railway station · MAS');
});

test('the empty-list message no longer implies that only bus stops exist', () => {
  assert.equal(ui.SUGGESTION_MESSAGES.empty, 'No matching place, bus stop or railway station.');
});

test('route distance counts the train: the provider distance, else the straight line between its stations', () => {
  const geo = bundle(`export { getRouteDistanceMeters } from './utils/routeGrouping';`, 'routedistance');
  const stop = (code, lat, lon) => ({ type: 'station', name: code, code, lat, lon });
  const ride = { mode: 'local_ride', kind: 'access', distanceMeters: 8000, from: { name: 'o' }, to: { name: 's' }, durationSeconds: 900, departureTime: 'x', arrivalTime: 'x' };
  const train = (extra) => ({ mode: 'rail', fromStop: stop('MAS', 13.08, 80.27), toStop: stop('BZA', 16.52, 80.62), departureTime: 'x', arrivalTime: 'x', durationSeconds: 3600, ...extra });
  assert.equal(geo.getRouteDistanceMeters({ legs: [ride, train({ scheduleEvidence: { distanceKm: 431 } })] }), 439000);
  const straight = geo.getRouteDistanceMeters({ legs: [ride, train({})] });
  assert.ok(straight > 390000 && straight < 400000, `${straight}`);
});
