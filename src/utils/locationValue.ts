// A search endpoint as the user chose it: the text shown in the field plus, when known, the coordinates behind it
// (picked from the suggestions, chosen on the map, or the device location). Swapping moves these objects whole, and
// "same place" is decided by coordinates when both sides have them, never by display text alone.

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface PlaceValue {
  text: string;
  coords: Coordinates | null;
}

export const EMPTY_PLACE: PlaceValue = { text: '', coords: null };

export const CURRENT_LOCATION_PATTERN = /^(?:📍\s*)?(?:my\s+)?current\s*location$/i;
export const CURRENT_LOCATION_LABEL = '📍 Current Location';

// Two points closer than this are the same place for a journey search (the same stop, or a pin on top of it).
export const SAME_PLACE_METERS = 75;

export const isCurrentLocationText = (text: string) => CURRENT_LOCATION_PATTERN.test(text.trim());

export function normalizePlaceText(text: string): string {
  return text
    .replace(/📍/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function metersBetween(a: Coordinates, b: Coordinates): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isSamePlace(a: PlaceValue, b: PlaceValue): boolean {
  if (a.coords && b.coords) return metersBetween(a.coords, b.coords) <= SAME_PLACE_METERS;
  const ta = normalizePlaceText(a.text);
  const tb = normalizePlaceText(b.text);
  return ta !== '' && ta === tb;
}

export function swapPlaces(places: { from: PlaceValue; to: PlaceValue }): { from: PlaceValue; to: PlaceValue } {
  return { from: places.to, to: places.from };
}

// Typing into a field invalidates coordinates picked earlier, except while the text still says "current location".
export function editPlaceText(previous: PlaceValue, text: string): PlaceValue {
  if (text === previous.text) return previous;
  return { text, coords: isCurrentLocationText(text) ? previous.coords : null };
}
