import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, val) => store.set(key, String(val)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear()
};

const {
  getUserStorageKey,
  getLocalTrips,
  saveLocalTrips,
  recordSearchTrip,
  removeTripFromHistory,
  syncPendingTripsWithServer
} = bundle(`
  export * from './utils/tripHistory';
`, 'trip-history');

describe('My Trips: search history for signed in user', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('getUserStorageKey separates signed in user storage from guest storage', () => {
    assert.equal(getUserStorageKey(42), 'my_trips_user_42');
    assert.equal(getUserStorageKey(null), 'my_trips');
    assert.equal(getUserStorageKey(undefined), 'my_trips');
  });

  test('records search history under user-specific storage when user is signed in', async () => {
    const user = { id: 101, name: 'Alice' };
    const trip = { from: 'Vijayawada', to: 'Guntur', date: '2026-11-01', time: '08:30' };

    const updated = await recordSearchTrip(trip, user, null);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].from, 'Vijayawada');
    assert.equal(updated[0].to, 'Guntur');
    assert.equal(updated[0].date, '2026-11-01');
    assert.equal(updated[0].time, '08:30');

    // User-scoped storage has the trip
    const userStored = JSON.parse(localStorage.getItem('my_trips_user_101') || '[]');
    assert.equal(userStored.length, 1);
    assert.equal(userStored[0].from, 'Vijayawada');

    // A different user does not see Alice's trip
    const bobTrips = getLocalTrips(202);
    assert.equal(bobTrips.length, 0);
  });

  test('deduplicates identical searches for the same user', async () => {
    const user = { id: 101, name: 'Alice' };
    const trip = { from: 'Vijayawada', to: 'Guntur', date: '2026-11-01', time: '08:30' };

    await recordSearchTrip(trip, user, null);
    const updated = await recordSearchTrip(trip, user, null);
    assert.equal(updated.length, 1);
  });

  test('removes trip from user-specific search history', async () => {
    const user = { id: 101, name: 'Alice' };
    await recordSearchTrip({ from: 'Vijayawada', to: 'Guntur', date: '2026-11-01' }, user, null);
    await recordSearchTrip({ from: 'Hyderabad', to: 'Warangal', date: '2026-11-02' }, user, null);

    let trips = getLocalTrips(user.id);
    assert.equal(trips.length, 2);

    const tripToDelete = trips[0].id;
    const remaining = await removeTripFromHistory(tripToDelete, user, null);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, trips[1].id);
  });

  test('syncs guest trips into signed-in user storage upon login', async () => {
    // Guest searches before signing in
    saveLocalTrips([{ id: 1, from: 'Tirupati', to: 'Nellore', date: '2026-11-05' }], null);

    // Existing user has an earlier search
    saveLocalTrips([{ id: 2, from: 'Visakhapatnam', to: 'Kakinada', date: '2026-11-06' }], 101);

    const synced = await syncPendingTripsWithServer(null, 101);
    assert.equal(synced.length, 2);
    assert.ok(synced.some(t => t.from === 'Tirupati'));
    assert.ok(synced.some(t => t.from === 'Visakhapatnam'));
  });
});
