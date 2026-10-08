import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, PROVIDER_COVERAGE, COVERAGE_TYPE, cityForRide, providerOptionsForRide } from '../providerCoverage.js';

const cityNamed = id => CITIES.find(city => city.id === id);
const near = (id, dLat = 0.01, dLon = 0.01) => ({ lat: cityNamed(id).lat + dLat, lon: cityNamed(id).lon + dLon });
const names = result => result.providerOptions.map(option => option.name);

describe('provider coverage data', () => {
  test('13. every claim cites an official public provider page, with source type, date and confidence', () => {
    const domains = { Uber: 'https://www.uber.com/', Rapido: 'https://rapido.bike/' };
    for (const entry of PROVIDER_COVERAGE) {
      assert.ok(entry.sourceType && entry.confidence && /^\d{4}-\d{2}-\d{2}$/.test(entry.lastChecked), entry.provider);
      for (const [cityId, url] of Object.entries(entry.cities)) {
        assert.ok(cityNamed(cityId), `${entry.provider}: unknown city ${cityId}`);
        assert.ok(url.startsWith(domains[entry.provider]), `${entry.provider} ${cityId}: ${url}`);
        assert.equal(entry.sourceType, 'official_city_page');
        assert.equal(entry.confidence, 'published_coverage');
      }
    }
  });

  test('14. a provider without a trustworthy city source (Ola) is never listed', () => {
    const ola = PROVIDER_COVERAGE.find(entry => entry.provider === 'Ola');
    assert.deepEqual(ola.cities, {});
    for (const city of CITIES) assert.ok(!names(providerOptionsForRide(near(city.id), near(city.id, 0.02, 0.0))).includes('Ola'));
  });

  test('cities whose official provider page does not exist are not claimed', () => {
    const uber = PROVIDER_COVERAGE.find(entry => entry.provider === 'Uber');
    for (const id of ['vijayawada', 'visakhapatnam', 'tirupati', 'kakinada']) assert.equal(uber.cities[id], undefined, id);
  });
});

describe('matching a ride to a city', () => {
  test('a ride inside Guntur lists the providers published for Guntur only', () => {
    const result = providerOptionsForRide(near('guntur'), near('guntur', 0.03, 0.02));
    assert.equal(result.city, 'Guntur');
    assert.deepEqual(names(result), ['Uber', 'Rapido']);
  });

  test('coverage is per city: Vijayawada has Rapido but not Uber; the state-wide existence of a provider is not enough', () => {
    assert.deepEqual(names(providerOptionsForRide(near('vijayawada'), near('vijayawada', 0.02, 0.01))), ['Rapido']);
    assert.deepEqual(names(providerOptionsForRide(near('tirupati'), near('tirupati', 0.02, 0.0))), ['Rapido']);
  });

  test('a ride outside every known city has no provider section', () => {
    const village = { lat: 16.2, lon: 80.15 };
    const result = providerOptionsForRide(village, { lat: 16.21, lon: 80.16 });
    assert.deepEqual(result, { city: null, providerOptions: [] });
  });

  test('both ends must be inside the city: a ride from a village into Guntur is not claimed as city coverage', () => {
    const village = { lat: 16.2, lon: 80.15 };
    assert.equal(cityForRide(village, near('guntur')), null);
    assert.deepEqual(providerOptionsForRide(village, near('guntur')).providerOptions, []);
  });

  test('a city with no configured provider coverage yields no options and no city', () => {
    const result = providerOptionsForRide(near('guntur'), near('guntur', 0.02, 0.02), { coverage: [] });
    assert.deepEqual(result, { city: null, providerOptions: [] });
  });
});

describe('what is (never) claimed', () => {
  test('15/20. city-level coverage never sets realtimeAvailable and is labelled published coverage', () => {
    for (const city of CITIES) {
      for (const option of providerOptionsForRide(near(city.id), near(city.id, 0.01, 0.02)).providerOptions) {
        assert.equal(option.realtimeAvailable, false);
        assert.equal(option.coverage, COVERAGE_TYPE);
        assert.equal(COVERAGE_TYPE, 'published_city_coverage');
      }
    }
  });

  test('18. options carry no price, ETA or availability fields, so provider-specific fares cannot be fabricated', () => {
    const [option] = providerOptionsForRide(near('guntur'), near('guntur', 0.01, 0.0)).providerOptions;
    assert.deepEqual(Object.keys(option).sort(), ['coverage', 'name', 'realtimeAvailable']);
  });
});
