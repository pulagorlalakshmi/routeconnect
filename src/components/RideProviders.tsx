import { RIDE_COVERAGE_NOTE, rideProviderLink } from '../config/externalServices';
import { TRACKER_LINK_REL } from '../config/apsrtcTrackers';

// "Possible ride services: Uber · Rapido". City-level published coverage only: never availability, never a price, and the
// leg itself stays a generic "local ride". Renders nothing when no provider has published coverage for the area.
export default function RideProviders({ city, options }: { city?: string | null; options?: { name: string }[] }) {
  if (!options || options.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-amber-200/70 pt-1.5">
      <p className="text-xs text-[#1F2933]">
        <span className="font-semibold">Possible ride services</span>
        {city ? <span className="text-[#667085]"> in {city}</span> : null}
        <span className="font-semibold">: {options.map(option => option.name).join(' · ')}</span>
      </p>
      <p className="text-[11px] text-[#667085]">{RIDE_COVERAGE_NOTE}</p>
      <p className="flex flex-wrap gap-1.5">
        {options.map(option => {
          const link = rideProviderLink(option.name);
          if (!link) return null;
          return (
            <a
              key={option.name}
              href={link.webUrl}
              target="_blank"
              rel={TRACKER_LINK_REL}
              aria-label={`Open ${option.name} website (external site, opens in a new tab)`}
              className="rounded-md border border-[#D9DED9] px-2 py-0.5 text-[11px] font-semibold text-[#667085] hover:border-[#146B5B]/50 hover:text-[#146B5B]"
            >
              Open {option.name}
            </a>
          );
        })}
      </p>
    </div>
  );
}
