import { Calendar, Clock } from 'lucide-react';
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
    <div className="w-full bg-[#F8FAF9] p-6 md:p-8 border border-[#D9DED9] rounded-xl shadow-sm">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-[0.2em] font-extrabold text-[#146B5B]">Journey Planner</p>
        <h2 className="mt-1 text-2xl font-black text-[#1F2933]">Plan a bus journey from published timetables</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* From & To Group with Centered Overlapping Swap Button */}
        <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-0 relative items-start">
          {/* From Location */}
          <div className="md:pr-3">
            <LocationInput
              label="From"
              placeholder="Enter starting location..."
              value={from}
              onChange={onFromChange}
              onCurrentLocation={onCurrentLocation}
              onCoordinates={onFromCoordinates}
            />
          </div>
          
          {/* Absolute Overlapping Swap Button for Desktop */}
          <div className="hidden md:block absolute left-1/2 top-[34px] -translate-x-1/2 z-10">
            <button
              type="button"
              onClick={onSwapLocations}
              title="Swap Locations"
              className="rounded-full border border-[#D9DED9] bg-white hover:bg-gray-50 text-[#146B5B] transition flex items-center justify-center font-black h-9 w-9 shadow-sm hover:shadow-md shrink-0"
            >
              ⇅
            </button>
          </div>

          {/* To Location */}
          <div className="md:pl-3">
            <LocationInput
              label="To"
              placeholder="Enter destination..."
              value={to}
              onChange={onToChange}
              onCoordinates={onToCoordinates}
            />
          </div>

          {/* Swap Button helper for mobile (visible under stacked layout) */}
          <div className="flex md:hidden justify-center py-1">
            <button
              type="button"
              onClick={onSwapLocations}
              className="px-4 py-1.5 rounded-full border border-[#D9DED9] bg-white text-xs font-bold text-[#146B5B]"
            >
              ⇅ Swap Locations
            </button>
          </div>
        </div>

        {/* Travel date and departure time */}
        <div className="lg:col-span-3 space-y-4">
          <div className="space-y-2">
            <label htmlFor="travel-date" className="block text-sm font-bold text-[#1F2933]">Date</label>
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
              <input
                id="travel-date"
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                min={todayLocalIso()}
                className="w-full pl-11 pr-4 py-3 text-sm font-semibold text-[#1F2933] border border-[#D9DED9] rounded-xl bg-white shadow-sm focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B] outline-none transition"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="travel-time" className="block text-sm font-bold text-[#1F2933]">Depart after <span className="font-semibold text-[#667085]">(India time)</span></label>
            <div className="relative">
              <Clock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667085]" />
              <input
                id="travel-time"
                type="time"
                value={time}
                onChange={(e) => onTimeChange(e.target.value)}
                className="w-full pl-11 pr-4 py-3 text-sm font-semibold text-[#1F2933] border border-[#D9DED9] rounded-xl bg-white shadow-sm focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B] outline-none transition"
                required
              />
            </div>
          </div>
        </div>
      </div>

      {/* Find All Routes Button */}
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onSearch}
          disabled={!isValid || loading}
          className="w-full sm:w-auto inline-flex items-center justify-center rounded-xl bg-[#146B5B] hover:bg-[#0f5447] text-white px-8 py-3.5 text-sm font-extrabold shadow-md hover:shadow-lg transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? 'Searching...' : 'Find All Routes'}
        </button>
      </div>
    </div>
  );
}
