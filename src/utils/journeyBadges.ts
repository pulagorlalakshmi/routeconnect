// Which label badges to show in a card header. Best Path is rendered inside the rating strip (never twice), and at
// most two badges in total are shown, so cards do not turn into a row of stickers.
import type { JourneyLabel } from '../services/planService';

const PRIORITY: JourneyLabel[] = ['FASTEST', 'LEAST_TRANSFERS', 'LOWER_ESTIMATED_COST', 'BEST_BALANCED'];
export const MAX_HEADER_BADGES = 2;

export function headerLabels(labels: JourneyLabel[]): JourneyLabel[] {
  const room = labels.includes('BEST_PATH') ? MAX_HEADER_BADGES - 1 : MAX_HEADER_BADGES;
  return PRIORITY.filter(label => labels.includes(label)).slice(0, room);
}
