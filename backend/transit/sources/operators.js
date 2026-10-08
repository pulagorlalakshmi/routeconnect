// Operator identity for a transit leg. The NAME always comes from the data source (GTFS agency.txt, a rail feed's
// agency, an airline from a flight API); this file only adds factual metadata about names it already knows.
// Nothing here infers an operator from a service number, a route code or a place. Unknown stays unknown.

export const OPERATOR_TYPES = Object.freeze(['state_transport', 'private_bus', 'rail', 'airline', 'local_transport', 'unknown']);

// Known public operators: canonical display name and type. Keys are normalised (upper case, no punctuation).
const KNOWN = Object.freeze({
  APSRTC: { name: 'APSRTC', type: 'state_transport' },
  'ANDHRA PRADESH STATE ROAD TRANSPORT CORPORATION': { name: 'APSRTC', type: 'state_transport' },
  TSRTC: { name: 'TGSRTC', type: 'state_transport' },
  TGSRTC: { name: 'TGSRTC', type: 'state_transport' },
  'TELANGANA STATE ROAD TRANSPORT CORPORATION': { name: 'TGSRTC', type: 'state_transport' },
  KSRTC: { name: 'KSRTC', type: 'state_transport' },
  'INDIAN RAILWAYS': { name: 'Indian Railways', type: 'rail' }
});

const normalise = name => String(name ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {string|null} name        operator name AS GIVEN by the source (null when the source gives none)
 * @param {{ source: string, confidence?: 'verified'|'published'|'inferred'|'unknown', typeHint?: string }} meta
 *   typeHint: the source's own category (e.g. a flight API's carrier is an 'airline'); never derived from a code.
 * @returns {{ name: string|null, type: string, source: string, confidence: string }}
 */
export function operatorIdentity(name, { source, confidence = 'published', typeHint = null } = {}) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return { name: null, type: 'unknown', source: source ?? 'none', confidence: 'unknown' };
  const known = KNOWN[normalise(clean)];
  const type = known?.type ?? (OPERATOR_TYPES.includes(typeHint) ? typeHint : 'unknown');
  return { name: known?.name ?? clean, type, source: source ?? 'unknown', confidence };
}

export const OPERATOR_NOT_IDENTIFIED = 'Operator not identified';
