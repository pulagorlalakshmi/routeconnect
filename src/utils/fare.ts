import type { FareEstimate, LegFare } from '../services/planService';

// Fares are shown as RANGES ("₹120–₹170"). An exact figure is only ever shown for a fare that came from a published
// source (type "published"), and none exists today.
const rupees = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`;

export function formatFareRange(fare: LegFare | FareEstimate | null | undefined): string | null {
  if (!fare) return null;
  if ('type' in fare && fare.type === 'published') return rupees(fare.amount);
  const range = fare as { min: number | null; max: number | null };
  if (range.min === null || range.max === null || range.min === undefined || range.max === undefined) return null;
  return range.min === range.max ? rupees(range.min) : `${rupees(range.min)}–${rupees(range.max)}`;
}

export function isEstimatedFare(fare: LegFare | FareEstimate | null | undefined): boolean {
  if (!fare) return false;
  if ('type' in fare) return fare.type === 'estimated_range';
  return fare.confidence === 'estimated';
}
