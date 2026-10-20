// RailRadar credentials: primary / backup configuration, the operator-chosen preferred key, the failover modes (off: never;
// auth: rejected keys only; quota: also used-up allowances and rate limits, with the preferred key first), a cache and
// in-flight requests shared across credentials, and key values that never appear in summaries, errors or logs.
// MOCKED keys and responses only: no real RailRadar request is made.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRailRadarClient } from '../verification/railRadar.js';
import { createCredentialManager } from '../verification/railRadarCredentials.js';
import { createRailRadarSource } from '../../sources/rail/railRadarSource.js';

const PRIMARY = 'rr_test_primary_0000000000000000000000';
const BACKUP = 'rr_test_backup_11111111111111111111111';
const listing = trains => ({ success: true, data: { trains }, meta: {} });
const oneTrain = listing([{ train: { number: '90001', name: 'Test Express', runDays: ['mon'] }, from: { code: 'TSA', departure: '07:00', day: 1 }, to: { code: 'TSB', arrival: '07:50', day: 1 }, distance: 30, duration: 50, totalHaltsBetween: 1 }]);

// A fake RailRadar: answers per key, records which key each request used (as "primary"/"backup", never the value).
// A behaviour may be a function of the call number for that key (to change answers over time), or throw (network failure).
function fakeRailRadar(behaviour) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const who = init.headers.Authorization === `Bearer ${PRIMARY}` ? 'primary' : init.headers.Authorization === `Bearer ${BACKUP}` ? 'backup' : 'unknown';
    calls.push(who);
    const spec = typeof behaviour[who] === 'function' ? behaviour[who](calls.filter(c => c === who).length) : behaviour[who];
    if (spec?.throws) throw spec.throws;
    const { status = 200, body = oneTrain, remaining = '50', retryAfter } = spec ?? {};
    const headers = { 'x-ratelimit-remaining-month': remaining, ...(retryAfter ? { 'retry-after': retryAfter } : {}) };
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, calls };
}
const env = extra => ({ RAILRADAR_API_KEY: PRIMARY, RAILRADAR_BACKUP_API_KEY: BACKUP, ...extra });

describe('configuration', () => {
  test('both keys detected; the primary is used; failover is OFF by default', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: env(), fetchImpl: rr.fetchImpl });
    const summary = client.credentials();
    assert.deepEqual(summary.credentials.map(c => [c.id, c.present, c.state]), [['primary', true, 'active'], ['backup', true, 'standby']]);
    assert.equal(summary.failover, 'off');
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.deepEqual(rr.calls, ['primary']);
  });

  test('an operator-chosen switch: RAILRADAR_ACTIVE_KEY=backup uses the backup credential', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: env({ RAILRADAR_ACTIVE_KEY: 'backup' }), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.deepEqual(rr.calls, ['backup']);
  });

  test('the selected key missing: unavailable with a reason (the other account is not borrowed unless failover is on)', () => {
    const off = createRailRadarClient({ env: { RAILRADAR_BACKUP_API_KEY: BACKUP }, fetchImpl: fakeRailRadar({}).fetchImpl });
    assert.deepEqual([off.availability().available, off.availability().code], [false, 'NOT_CONFIGURED']);
    assert.match(off.availability().reason, /selected RailRadar credential \(primary\)/);
    const on = createRailRadarClient({ env: { RAILRADAR_BACKUP_API_KEY: BACKUP, RAILRADAR_KEY_FAILOVER: 'auth' }, fetchImpl: fakeRailRadar({}).fetchImpl });
    assert.equal(on.availability().credentialId, 'backup');
  });

  test('unknown failover values are treated as off', () => {
    assert.equal(createCredentialManager({ env: env({ RAILRADAR_KEY_FAILOVER: 'pool' }) }).failover, 'off');
  });

  test('under the test runner without an explicit fetch, no key is ever used (protects the real quota)', () => {
    const client = createRailRadarClient({ env: env() });
    assert.equal(client.configured, false);
    assert.deepEqual(client.credentials().credentials.map(c => c.present), [false, false]);
  });
});

describe('failover only for rejected credentials, and only when enabled', () => {
  test('failover off: a rejected primary means scheduled trains are unavailable; the backup is never tried', async () => {
    const rr = fakeRailRadar({ primary: { status: 401 } });
    const client = createRailRadarClient({ env: env(), fetchImpl: rr.fetchImpl });
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'UNAUTHORIZED');
    assert.deepEqual(rr.calls, ['primary']);
    assert.equal(client.availability().code, 'UNAUTHORIZED');
    assert.equal(client.credentials().credentials[0].state, 'rejected');
  });

  test('failover "auth": a revoked primary (401/403) hands over to the backup once, and the request succeeds', async () => {
    for (const status of [401, 403]) {
      const rr = fakeRailRadar({ primary: { status } });
      const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth' }), fetchImpl: rr.fetchImpl });
      const trains = await client.trainsBetween('TSA', 'TSB', '2026-10-20');
      assert.equal(trains[0].number, '90001');
      assert.deepEqual(rr.calls, ['primary', 'backup']);
      assert.deepEqual(client.credentials().credentials.map(c => c.state), ['rejected', 'active']);
    }
  });

  test('both rejected: one retry only, then a clear "unavailable"', async () => {
    const rr = fakeRailRadar({ primary: { status: 401 }, backup: { status: 401 } });
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth' }), fetchImpl: rr.fetchImpl });
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'UNAUTHORIZED');
    assert.deepEqual(rr.calls, ['primary', 'backup']);
    assert.equal(client.availability().available, false);
  });
});

describe('quota: never pooled across accounts unless failover is "quota"', () => {
  test('a rate limit (429) never moves to the backup, even with failover "auth"', async () => {
    const rr = fakeRailRadar({ primary: { status: 429, remaining: '0' } });
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth' }), fetchImpl: rr.fetchImpl });
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'RATE_LIMITED');
    assert.deepEqual(rr.calls, ['primary']);
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-21'), e => e.code === 'BUDGET_EXHAUSTED', 'RailRadar said none remain: no further requests');
    assert.deepEqual(rr.calls, ['primary']);
  });

  test('RailRadar reporting 0 remaining stops further requests; the backup is not used to continue', async () => {
    const rr = fakeRailRadar({ primary: { remaining: '0' } });
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth' }), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-21'), e => e.code === 'BUDGET_EXHAUSTED');
    assert.deepEqual(rr.calls, ['primary']);
    assert.deepEqual(client.credentials().credentials.map(c => c.state), ['quota_exhausted', 'standby']);
  });

  test('the local per-credential budget is respected the same way', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth', RAILRADAR_MONTHLY_REQUEST_BUDGET: '1' }), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-21'), e => e.code === 'BUDGET_EXHAUSTED');
    assert.deepEqual(rr.calls, ['primary']);
  });

  test('the timetable cache is shared across credentials: a cached answer costs nothing after a switch', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'auth' }), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    const again = await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.equal(again[0].number, '90001');
    assert.deepEqual(rr.calls, ['primary']);
  });
});

describe('failover "quota": the confirmed multi-account arrangement', () => {
  const quotaEnv = extra => env({ RAILRADAR_KEY_FAILOVER: 'quota', ...extra });
  const clock = start => { let t = new Date(start).getTime(); return { now: () => new Date(t), advance: ms => { t += ms; } }; };

  test('the primary is used first; the backup stays on standby while the primary has allowance', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await client.trainsBetween('TSA', 'TSB', '2026-10-21');
    assert.deepEqual(rr.calls, ['primary', 'primary']);
    assert.deepEqual(client.credentials().credentials.map(c => c.state), ['active', 'standby']);
  });

  test('RailRadar reports 0 remaining on the primary: that answer is used, and the next search goes to the backup', async () => {
    const rr = fakeRailRadar({ primary: { remaining: '0' } });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    assert.equal((await client.trainsBetween('TSA', 'TSB', '2026-10-20'))[0].number, '90001');
    assert.equal((await client.trainsBetween('TSA', 'TSB', '2026-10-21'))[0].number, '90001');
    assert.deepEqual(rr.calls, ['primary', 'backup'], 'no request is wasted on the used-up primary');
    const summary = client.credentials();
    assert.deepEqual(summary.credentials.map(c => c.state), ['quota_exhausted', 'active']);
    assert.deepEqual([summary.active, summary.lastFailover.from, summary.lastFailover.to, summary.lastFailover.reason], ['backup', 'primary', 'backup', 'quota_exhausted']);
    assert.equal(client.budget().active, 'backup');
  });

  test('a 429 on the primary is retried once on the backup and the search succeeds; the primary is used again after its cooldown', async () => {
    const time = clock('2026-10-20T06:00:00Z');
    const rr = fakeRailRadar({ primary: n => (n === 1 ? { status: 429, retryAfter: '120' } : {}) });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl, now: time.now });
    assert.equal((await client.trainsBetween('TSA', 'TSB', '2026-10-20'))[0].number, '90001');
    assert.deepEqual(rr.calls, ['primary', 'backup']);
    assert.deepEqual(client.credentials().credentials.map(c => c.state), ['rate_limited', 'active']);
    await client.trainsBetween('TSA', 'TSB', '2026-10-21');
    assert.deepEqual(rr.calls, ['primary', 'backup', 'backup'], 'still resting: the backup answers');
    time.advance(121 * 1000);
    await client.trainsBetween('TSA', 'TSB', '2026-10-22');
    assert.deepEqual(rr.calls, ['primary', 'backup', 'backup', 'primary'], 'the primary is preferred again once it recovers');
  });

  test('the local per-credential budget hands over to the backup the same way', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: quotaEnv({ RAILRADAR_MONTHLY_REQUEST_BUDGET: '1' }), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await client.trainsBetween('TSA', 'TSB', '2026-10-21');
    assert.deepEqual(rr.calls, ['primary', 'backup']);
  });

  test('a rejected primary (401/403) hands over to the backup and the request succeeds', async () => {
    for (const status of [401, 403]) {
      const rr = fakeRailRadar({ primary: { status } });
      const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
      assert.equal((await client.trainsBetween('TSA', 'TSB', '2026-10-20'))[0].number, '90001');
      assert.deepEqual(rr.calls, ['primary', 'backup']);
      assert.equal(client.credentials().lastFailover.reason, 'rejected');
    }
  });

  test('both allowances used up: scheduled trains are unavailable with a clear reason, and no further requests are made', async () => {
    const rr = fakeRailRadar({ primary: { remaining: '0' }, backup: { remaining: '0' } });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await client.trainsBetween('TSA', 'TSB', '2026-10-21');
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-22'), e => e.code === 'BUDGET_EXHAUSTED');
    assert.deepEqual(rr.calls, ['primary', 'backup']);
    assert.deepEqual([client.availability().available, client.availability().code], [false, 'BUDGET_EXHAUSTED']);
    assert.match(client.availability().reason, /every configured RailRadar key/);
  });

  test('both rate-limited: one retry only, then RATE_LIMITED (no request loop)', async () => {
    const rr = fakeRailRadar({ primary: { status: 429 }, backup: { status: 429 } });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'RATE_LIMITED');
    assert.deepEqual(rr.calls, ['primary', 'backup']);
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-21'), e => e.code === 'RATE_LIMITED');
    assert.deepEqual(rr.calls, ['primary', 'backup'], 'resting keys are not called');
  });

  test('a new month: the primary allowance resets and the primary is used again', async () => {
    const time = clock('2026-10-31T12:00:00Z');
    const rr = fakeRailRadar({ primary: n => (n === 1 ? { remaining: '0' } : { remaining: '100' }) });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl, now: time.now });
    await client.trainsBetween('TSA', 'TSB', '2026-10-31');
    await client.trainsBetween('TSA', 'TSB', '2026-11-01');
    time.advance(24 * 3600 * 1000);
    await client.trainsBetween('TSA', 'TSB', '2026-11-02');
    assert.deepEqual(rr.calls, ['primary', 'backup', 'primary']);
  });

  test('provider-wide failures (network, 5xx) never switch keys or spend the backup allowance', async () => {
    const down = fakeRailRadar({ primary: { throws: new TypeError('fetch failed') } });
    const a = createRailRadarClient({ env: quotaEnv(), fetchImpl: down.fetchImpl });
    await assert.rejects(a.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'NETWORK');
    const broken = fakeRailRadar({ primary: { status: 503 } });
    const b = createRailRadarClient({ env: quotaEnv(), fetchImpl: broken.fetchImpl });
    await assert.rejects(b.trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'PROVIDER_ERROR');
    assert.deepEqual([down.calls, broken.calls], [['primary'], ['primary']]);
  });

  test('only the backup configured: it is used directly', async () => {
    const rr = fakeRailRadar({});
    const client = createRailRadarClient({ env: { RAILRADAR_BACKUP_API_KEY: BACKUP, RAILRADAR_KEY_FAILOVER: 'quota' }, fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.deepEqual(rr.calls, ['backup']);
  });

  test('a cached answer costs nothing after a switch', async () => {
    const rr = fakeRailRadar({ primary: { remaining: '0' } });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    await client.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.deepEqual(rr.calls, ['primary']);
  });

  test('train search keeps working after an authorised failover (planner source end to end)', async () => {
    const graph = { stations: [
      { code: 'TSA', name: 'Test Alpha Junction', kind: 'station', lat: 16.518, lon: 80.618 },
      { code: 'TSB', name: 'Test Beta Junction', kind: 'station', lat: 16.300, lon: 80.442 }
    ] };
    const ctx = date => ({ origin: { lat: 16.519, lon: 80.619 }, destination: { lat: 16.301, lon: 80.443 }, date, windowStartSeconds: 6 * 3600, windowEndSeconds: 12 * 3600, utcOffset: '+05:30', crowFliesMeters: 30000 });
    const rr = fakeRailRadar({ primary: { remaining: '0' } });
    const client = createRailRadarClient({ env: quotaEnv(), fetchImpl: rr.fetchImpl });
    const source = createRailRadarSource({ client, getGraph: () => graph });
    const first = await source.search(ctx('2026-10-20'));
    assert.equal(source.status(ctx('2026-10-21')).configured, true, 'the backup keeps scheduled trains available');
    const second = await source.search(ctx('2026-10-21'));
    assert.deepEqual(rr.calls, ['primary', 'backup']);
    for (const out of [first, second]) {
      assert.equal(out.trunks.length, 1);
      assert.deepEqual([out.trunks[0][0].trainNumber, out.trunks[0][0].source.id], ['90001', 'railradar']);
    }
    assert.equal(second.meta.budget.active, 'backup');
  });
});

describe('no duplicate requests', () => {
  test('identical concurrent questions share one request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const fetchImpl = async () => { calls.push(1); await gate; return new Response(JSON.stringify(oneTrain), { headers: { 'x-ratelimit-remaining-month': '50' } }); };
    const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: 'quota' }), fetchImpl });
    const all = Promise.all([1, 2, 3].map(() => client.trainsBetween('TSA', 'TSB', '2026-10-20')));
    release();
    const answers = await all;
    assert.equal(calls.length, 1);
    assert.ok(answers.every(a => a[0].number === '90001'));
    assert.equal(client.credentials().credentials[0].usedThisMonth, 1);
  });

  test('a failed shared request is not remembered: the next search asks again', async () => {
    let n = 0;
    const fetchImpl = async () => (++n === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(oneTrain)));
    const client = createRailRadarClient({ env: env(), fetchImpl });
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'));
    assert.equal((await client.trainsBetween('TSA', 'TSB', '2026-10-20'))[0].number, '90001');
  });
});

describe('secrets never leak; the planner degrades gracefully', () => {
  test('summaries, availability and errors never contain a key value', async () => {
    for (const failover of ['auth', 'quota']) {
      const rr = fakeRailRadar({ primary: { status: 401 }, backup: { status: 429 } });
      const client = createRailRadarClient({ env: env({ RAILRADAR_KEY_FAILOVER: failover }), fetchImpl: rr.fetchImpl });
      let error;
      try { await client.trainsBetween('TSA', 'TSB', '2026-10-20'); } catch (e) { error = e; }
      const everything = JSON.stringify([client.credentials(), client.availability(), client.budget(), error?.message, String(error)]);
      assert.ok(!everything.includes(PRIMARY) && !everything.includes(BACKUP));
    }
    assert.ok(!JSON.stringify(createCredentialManager({ env: env() })).includes(PRIMARY), 'the manager object itself holds no readable key');
  });

  test('no usable credential: the rail source reports itself unavailable (buses + estimated explorer take over)', async () => {
    const rr = fakeRailRadar({ primary: { status: 401 } });
    const client = createRailRadarClient({ env: env(), fetchImpl: rr.fetchImpl });
    const source = createRailRadarSource({ client, getGraph: () => ({ stations: [] }) });
    assert.equal(source.status({ crowFliesMeters: 1e6 }).configured, true);
    await assert.rejects(client.trainsBetween('TSA', 'TSB', '2026-10-20'));
    const state = source.status({ crowFliesMeters: 1e6 });
    assert.deepEqual([state.configured, state.code], [false, 'UNAUTHORIZED']);
    assert.match(state.reason, /rejected/);
  });
});
