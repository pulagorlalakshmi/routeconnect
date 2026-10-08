import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trackingOptionsFor, APSRTC_TRACKER_IDS } from '../trackingOptions.js';
import { busIdentity } from '../../routing/journeyBuilder.js';
import { makeNetwork, plan, lineSpec } from '../../routing/__tests__/helpers.js';

describe('tracking options model', () => {
  test('an APSRTC leg gets the service number, a null vehicle number, a tracking status and the three providers in priority order', () => {
    const tracking = trackingOptionsFor({ operator: 'APSRTC', serviceNumber: '09999' }); // never checked
    assert.deepEqual(tracking, {
      serviceNumber: '09999',
      vehicleNumber: null,
      status: 'options_available',
      providers: [
        { id: 'apsrtc', recognized: null, availableAsExternalOption: true },
        { id: 'redbus', recognized: null, availableAsExternalOption: true },
        { id: 'abhibus', recognized: null, availableAsExternalOption: true }
      ],
      preferredProvider: null,
      checkedOn: null
    });
    assert.deepEqual(APSRTC_TRACKER_IDS, ['apsrtc', 'redbus', 'abhibus']);
  });

  test('nothing claims live availability: there is no liveAvailable field', () => {
    assert.doesNotMatch(JSON.stringify(trackingOptionsFor({ operator: 'APSRTC', serviceNumber: '03846' })), /liveAvailable|"live"/i);
  });

  test('no tracking options without a service number or for other operators', () => {
    assert.equal(trackingOptionsFor({ operator: 'APSRTC', serviceNumber: null }), null);
    assert.equal(trackingOptionsFor({ operator: null, serviceNumber: '03846' }), null);
  });

  test('busIdentity carries tracking and still never fabricates a vehicle number', () => {
    const id = busIdentity({ shortName: '03846', agencyName: 'APSRTC' }, {});
    assert.equal(id.tracking.serviceNumber, '3846', 'trackers get the public number, without the feed leading zero');
    assert.equal(id.vehicleNumber, null);
    assert.equal(id.tracking.vehicleNumber, null);
  });

  test('planner legs from a non-APSRTC feed carry no tracking options', () => {
    const spec = lineSpec();
    const result = plan(makeNetwork(spec), spec, { from: 'A', to: 'C' });
    assert.equal(result.journeys[0].legs[0].tracking, null);
  });
});
