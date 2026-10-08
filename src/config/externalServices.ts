// External ride-provider links. (APSRTC tracking options live in apsrtcTrackers.ts.) No component hardcodes a URL.
// RouteConnect has NO ride-provider integration: these are official public pages the user opens on purpose. Nothing here
// is fetched or called automatically, and nothing about the user is passed on.

export interface RideProviderLink {
  // Official public web page of the provider (not a booking link, not a deep link with trip data).
  webUrl: string;
}

export const EXTERNAL_SERVICES = Object.freeze({
  rideProviders: Object.freeze({
    Uber: Object.freeze({ webUrl: 'https://www.uber.com/in/en/' }),
    Rapido: Object.freeze({ webUrl: 'https://www.rapido.bike/' }),
    Ola: Object.freeze({ webUrl: 'https://www.olacabs.com/' })
  } as Record<string, RideProviderLink>)
});

export const RIDE_COVERAGE_NOTE = 'City-level coverage only. Check provider apps for live availability and final fare.';

export function rideProviderLink(name: string): RideProviderLink | null {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_SERVICES.rideProviders, name) ? EXTERNAL_SERVICES.rideProviders[name] : null;
}
