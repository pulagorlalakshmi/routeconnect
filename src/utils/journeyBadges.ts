// Which label badges to show on a card's summary. Only the labels that help a decision are eligible (Best Path,
// Fastest, Lower cost, Fewest transfers; "Best balanced" overlaps Best Path and is never shown), and at most two are
// shown, so cards do not turn into a row of stickers.
import type { JourneyLabel } from '../services/planService';

const PRIORITY: JourneyLabel[] = ['BEST_PATH', 'FASTEST', 'LOWER_ESTIMATED_COST', 'LEAST_TRANSFERS'];
export const MAX_HEADER_BADGES = 2;

export function headerLabels(labels: JourneyLabel[]): JourneyLabel[] {
  return PRIORITY.filter(label => labels.includes(label)).slice(0, MAX_HEADER_BADGES);
}
