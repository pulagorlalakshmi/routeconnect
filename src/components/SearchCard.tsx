import { ArrowUpDown, Calendar, Clock, Search } from 'lucide-react';
import LocationInput from './LocationInput';
import { todayLocalIso } from '../utils/dateTime';

interface SearchCardProps {
  from: string;
  to: string;
  date: string;
  time: string;
  onFromChange: (value: string) => void;
  onCurrentLocation: (latitude: number, longitude: number) => void;
  onFromCoordinates?: (latitude: number, longitude: number) => void;
  onToChange: (value: string) => void;
  onToCoordinates?: (latitude: number, longitude: number) => void;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  onSwapLocations: () => void;
  onSearch: () => void;
  loading: boolean;
  isValid: boolean;
}

const fieldClass = 'w-full pl-11 pr-3 py-3.5 text-base font-semibold text-[#1F2933] border border-[#D0D9D5] rounded-xl bg-white outline-none transition hover:border-[#B9C6C1] focus:border-[#146B5B] focus:ring-2 focus:ring-[#146B5B]/20';

// The home search card: From and To stacked (with one obvious swap button between them), then date and time, then a
// single primary action. Nothing else competes for attention.
export default function SearchCard({
  from,
  to,
  date,
  time,
  onFromChange,
  onCurrentLocation,
  onFromCoordinates,
  onToChange,
  onToCoordinates,
  onDateChange,
  onTimeChange,
  onSwapLocations,
  onSearch,
  loading,
  isValid,
}: SearchCardProps) {
  return (
    <form
      aria-label="Plan your journey"
      onSubmit={(event) => { event.preventDefault(); if (isValid && !loading) onSearch(); }}
      className="w-full bg-white p-5 sm:p-8 border border-[#D9E2DE] rounded-2xl shadow-lg shadow-[#1F2933]/5"
    >
      <h1 className="text-2xl sm:text-[28px] font-black tracking-tight text-[#1F2933]">Plan your journey</h1>

      <div className="relative mt-6 space-y-4">
        <LocationInput
          kind="origin"
          label="From"
          placeholder="Search a place or stop"
          value={from}
          onChange={onFromChange}
          onCurrentLocation={onCurrentLocation}
          onCoordinates={onFromCoordinates}
        />

        {/* One swap button, sitting on the right between the two fields (in the "To" label row) */}
        <button
          type="button"
          onClick={onSwapLocations}
          title="Swap From and To"
          aria-label="Swap From and To"
          className="absolute right-1 top-1/2 z-10 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#D0D9D5] bg-white text-[#146B5B] shadow-sm transition hover:bg-[#EEF6F3] hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>

        <LocationInput
          kind="destination"
          label="To"
          placeholder="Search a place or stop"
          value={to}
          onChange={onToChange}
          onCoordinates={onToCoordinates}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="travel-date" className="block text-sm font-bold text-[#1F2933]">Date</label>
          <div className="relative">
            <Calendar aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
            <input
              id="travel-date"
              type="date"
              value={date}
              onChange={(e) => onDateChange(e.target.value)}
              min={todayLocalIso()}
              className={fieldClass}
              required
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="travel-time" className="block text-sm font-bold text-[#1F2933]">Depart after <span className="font-medium text-[#667085]">(India time)</span></label>
          <div className="relative">
            <Clock aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
            <input
              id="travel-time"
              type="time"
              value={time}
              onChange={(e) => onTimeChange(e.target.value)}
              className={fieldClass}
              required
            />
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={!isValid || loading}
        className="mt-7 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#146B5B] hover:bg-[#0f5447] text-white px-8 py-4 text-base font-extrabold shadow-md hover:shadow-lg transition focus:outline-none focus-visible:ring-4 focus-visible:ring-[#146B5B]/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Search aria-hidden className="h-5 w-5" />
        {loading ? 'Searching…' : 'Search routes'}
      </button>
    </form>
  );
}
