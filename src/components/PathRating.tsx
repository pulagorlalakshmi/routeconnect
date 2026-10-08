import { useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import type { PathRating as PathRatingData, RatingParameterKey } from '../services/planService';

const ROWS: { key: RatingParameterKey; label: string }[] = [
  { key: 'time', label: 'Time Efficiency' },
  { key: 'cost', label: 'Cost Efficiency' },
  { key: 'transfers', label: 'Transfer Convenience' },
  { key: 'firstLastMile', label: 'First / Last Mile' },
  { key: 'schedule', label: 'Schedule Confidence' },
  { key: 'tracking', label: 'Tracking Confidence' },
  { key: 'convenience', label: 'Convenience (directness)' }
];

export interface TrustSummary { route: string; tracking: string }

const format = (score: number) => (score >= 10 ? '10' : score.toFixed(1));

// The full explanation: the rating parameters, the route/tracking trust lines, 2-4 short reasons and a one-line note. Only rendered on request.
export function RatingBreakdown({ rating, id, trust }: { rating: PathRatingData; id?: string; trust?: TrustSummary }) {
  return (
    <div id={id} className="mt-2 border-t border-[#E4E9E6] pt-2 space-y-2">
      <p className="text-xs text-[#1F2933]">{rating.summary}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs text-[#667085] max-w-sm">
        {ROWS.filter(({ key }) => rating.parameters[key] !== undefined).map(({ key, label }) => {
          const score = rating.parameters[key]?.score ?? null;
          return (
            <div key={key} className="contents">
              <dt>{label}</dt>
              <dd className="text-right font-semibold text-[#1F2933] tabular-nums">{score === null ? 'N/A' : `${format(score)} / 10`}</dd>
            </div>
          );
        })}
      </dl>
      {trust && (
        <dl aria-label="Trust" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 rounded-md bg-white/70 px-2 py-1.5 text-xs max-w-sm">
          <dt className="text-[#667085]">Route confidence</dt>
          <dd className="font-semibold text-[#1F2933]">{trust.route}</dd>
          <dt className="text-[#667085]">Tracking</dt>
          <dd className="font-semibold text-[#1F2933]">{trust.tracking}</dd>
        </dl>
      )}
      {rating.reasons.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {rating.reasons.map(reason => (
            <li key={`${reason.metric}-${reason.text}`} className={`flex items-start gap-1.5 ${reason.type === 'caution' ? 'text-amber-800' : 'text-emerald-800'}`}>
              {reason.type === 'caution' ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-label="Caution" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-label="Positive" />}
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-[#667085]">
        Time and cost are compared with the other options in this search; fares are estimates. An N/A item is left out and the other weights are rebalanced.
      </p>
    </div>
  );
}

// Compact by default: just the title, score and label. The full breakdown is only rendered after the user asks for it.
export default function PathRating({ rating, isBest, trust }: { rating: PathRatingData; isBest: boolean; trust?: TrustSummary }) {
  const [open, setOpen] = useState(false);
  const panelId = `rating-details-${useId()}`;

  return (
    <section aria-label="Path rating" className="mb-3 rounded-lg bg-[#F8FAF9] border border-[#E4E9E6] px-3 py-2">
      <div className="flex items-center justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#667085]">{isBest ? 'Best Path' : 'Path Rating'}</p>
          <p className="text-sm text-[#1F2933]">
            <strong className="font-black">{rating.score.toFixed(1)} / 10</strong>
            <span className="text-[#667085]"> · {rating.label}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-[#146B5B] hover:underline cursor-pointer"
        >
          Why this rating? {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {open && <RatingBreakdown rating={rating} id={panelId} trust={trust} />}
    </section>
  );
}
