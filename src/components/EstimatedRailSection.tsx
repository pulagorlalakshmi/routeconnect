import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, MapPin, TrainFront } from 'lucide-react';
import { durationRange, ESTIMATED_RAIL_LABEL, explorerKey, fetchRailExplorer, recallRailExplorer } from '../services/railExplorer';
import type { EstimatedRailConnection, RailExplorerResponse } from '../services/railExplorer';

// Estimated rail connections: railway TRACK mapped in OpenStreetMap plus an assumed travel-time model. Shown either as
// the whole result ("Estimated rail") or as its own section below the planned journeys ("No preference"); never mixed
// into, counted with or ranked against them. Nothing here has a clock time, a train number or a fare: none is known.

const RAIL_HEX = '#2F5D8C';
const ROAD_HEX = '#98A2B3';

// The strip: origin → station (by road) → station (estimated rail) → destination (by road). Same visual language as the
// journey strip, but the rail stretch is dashed because it is an estimate, and labels are distances, never times.
export function RailCorridorStrip({ connection, animate = true }: { connection: EstimatedRailConnection; animate?: boolean }) {
  const startKm = connection.startStation.distanceFromOriginKm ?? 0;
  const endKm = connection.endStation.distanceToDestinationKm ?? 0;
  return (
    <div className="relative px-1 pt-9 pb-14" aria-label={`From your start, about ${startKm} km to ${connection.startStation.name}, then about ${connection.distanceKm} km of railway to ${connection.endStation.name}, then about ${endKm} km to your destination`}>
      <div className="relative flex items-center">
        <Dot label="Start" />
        <div className="relative mx-1 h-1.5 flex-[1] rounded-full" style={{ background: `repeating-linear-gradient(90deg, ${ROAD_HEX} 0 6px, transparent 6px 10px)` }}>
          <SegmentLabel text={`${startKm} km`} sub="to station" />
        </div>
        <Dot label={connection.startStation.name} code={connection.startStation.code} station />
        <div className="relative mx-1 h-2 flex-[4] rounded-full" style={{ background: `repeating-linear-gradient(90deg, ${RAIL_HEX} 0 16px, ${RAIL_HEX}55 16px 22px)` }}>
          <SegmentLabel text={`≈ ${connection.distanceKm} km`} sub="estimated rail" />
          <span
            aria-hidden
            className={`rc-erc-runner absolute top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[#2F5D8C] text-white shadow-md ${animate ? '' : 'rc-erc-still'}`}
          >
            <TrainFront className="h-4 w-4" />
          </span>
        </div>
        <Dot label={connection.endStation.name} code={connection.endStation.code} station />
        <div className="relative mx-1 h-1.5 flex-[1] rounded-full" style={{ background: `repeating-linear-gradient(90deg, ${ROAD_HEX} 0 6px, transparent 6px 10px)` }}>
          <SegmentLabel text={`${endKm} km`} sub="from station" />
        </div>
        <Dot label="Destination" />
      </div>
    </div>
  );
}

function Dot({ label, code, station }: { label: string; code?: string | null; station?: boolean }) {
  return (
    <span className="relative flex shrink-0 flex-col items-center">
      <span className={`block rounded-full border-2 ${station ? 'h-3.5 w-3.5 border-[#2F5D8C] bg-white' : 'h-3 w-3 border-[#98A2B3] bg-white'}`} />
      <span className="absolute top-5 w-20 -translate-x-0 text-center text-[11px] font-bold leading-tight text-[#1F2933] sm:w-28">
        {label}{code ? <span className="block font-semibold text-[#667085]">{code}</span> : null}
      </span>
    </span>
  );
}

function SegmentLabel({ text, sub }: { text: string; sub: string }) {
  return (
    <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-center text-[11px] leading-tight">
      <span className="block font-black text-[#1F2933] tabular-nums">{text}</span>
      <span className="block text-[10px] text-[#667085]">{sub}</span>
    </span>
  );
}

// A small schematic map of the mapped track (no basemap), with the OpenStreetMap attribution it requires.
export function RailCorridorMap({ connection, attribution }: { connection: EstimatedRailConnection; attribution: string }) {
  const pts = connection.geometry;
  if (pts.length < 2) return null;
  const W = 320;
  const H = 180;
  const pad = 14;
  const k = Math.cos(((pts[0][0] + pts[pts.length - 1][0]) / 2) * Math.PI / 180);
  const xs = pts.map(p => p[1] * k);
  const ys = pts.map(p => p[0]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1e-6), (H - 2 * pad) / Math.max(maxY - minY, 1e-6));
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  const project = (lat: number, lon: number) => [offX + (lon * k - minX) * scale, H - (offY + (lat - minY) * scale)];
  const path = pts.map(([lat, lon], i) => { const [x, y] = project(lat, lon); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  const [sx, sy] = project(connection.startStation.lat, connection.startStation.lon);
  const [ex, ey] = project(connection.endStation.lat, connection.endStation.lon);
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Schematic map of the mapped railway from ${connection.startStation.name} to ${connection.endStation.name}`} className="h-auto w-full rounded-xl bg-[#F4F7F6]">
        <path d={path} fill="none" stroke="#C9D6E3" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <path d={path} fill="none" stroke={RAIL_HEX} strokeWidth={2.5} strokeDasharray="7 5" strokeLinecap="round" strokeLinejoin="round" className="rc-erc-dash" />
        <circle cx={sx} cy={sy} r={5} fill="#fff" stroke={RAIL_HEX} strokeWidth={2.5} />
        <circle cx={ex} cy={ey} r={5} fill="#fff" stroke={RAIL_HEX} strokeWidth={2.5} />
        <text x={sx + 8} y={sy - 6} fontSize="10" fontWeight="700" fill="#1F2933">{connection.startStation.code ?? connection.startStation.name}</text>
        <text x={ex + 8} y={ey - 6} fontSize="10" fontWeight="700" fill="#1F2933">{connection.endStation.code ?? connection.endStation.name}</text>
      </svg>
      <figcaption className="mt-1 text-[10px] text-[#667085]">
        Track: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline">{attribution}</a> (ODbL)
      </figcaption>
    </figure>
  );
}

export function EstimatedRailCard({ connection, attribution, assumptions }: { connection: EstimatedRailConnection; attribution: string; assumptions: string[] }) {
  const [open, setOpen] = useState(false);
  const d = connection.estimatedDuration;
  const via = connection.corridor.via.length > 0 ? `via ${connection.corridor.via.join(', ')}` : connection.corridor.names[0] ?? null;
  return (
    <article aria-label={ESTIMATED_RAIL_LABEL} className="rounded-2xl border border-[#C9D6E3] bg-white p-4 shadow-sm transition-colors duration-200 hover:border-[#2F5D8C]/40 sm:p-6">
      <header className="flex flex-col-reverse gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#2F5D8C] text-white"><TrainFront aria-hidden className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h3 className="text-lg font-black leading-snug text-[#1F2933] md:text-xl">
              Estimated railway connection{connection.alternative ? <span className="ml-2 align-middle text-xs font-bold text-[#667085]">other corridor</span> : null}
            </h3>
            <p className="mt-0.5 text-sm font-bold text-[#1F2933]">
              {connection.startStation.name}{connection.startStation.code ? ` (${connection.startStation.code})` : ''} → {connection.endStation.name}{connection.endStation.code ? ` (${connection.endStation.code})` : ''}
            </p>
            {via && <p className="text-xs text-[#667085]">{via}</p>}
          </div>
        </div>
        <span className="shrink-0 self-start rounded-full border border-[#C9D6E3] bg-[#EFF5FB] px-2.5 py-0.5 text-xs font-bold text-[#2F5D8C]">{ESTIMATED_STATUS}</span>
      </header>

      <section aria-label="Corridor preview" className="mt-3 overflow-x-auto overflow-y-hidden rounded-xl bg-[#F7FAF9] px-3 sm:px-5">
        <div className="min-w-[520px]"><RailCorridorStrip connection={connection} /></div>
      </section>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-[#667085]">Rail distance</dt>
          <dd className="mt-0.5 text-lg font-black text-[#1F2933] tabular-nums">≈ {connection.distanceKm} km</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-[#667085]">Estimated duration</dt>
          <dd className="mt-0.5 text-lg font-black text-[#1F2933] tabular-nums">{durationRange(d.minMinutes, d.maxMinutes)}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-[#667085]">Stations on the line</dt>
          <dd className="mt-0.5 text-lg font-black text-[#1F2933] tabular-nums">{connection.intermediateStationCount} in between</dd>
        </div>
      </dl>

      <div className="mt-4 flex justify-end border-t border-[#EEF1EF] pt-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-xl bg-[#EFF5FB] px-4 py-2 text-sm font-bold text-[#2F5D8C] transition-colors hover:bg-[#E2EDF8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2F5D8C]">
          {open ? 'Hide details' : 'More details'}
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {open && (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <RailCorridorMap connection={connection} attribution={attribution} />
          <div className="space-y-3 text-xs text-[#475467]">
            <p>
              <strong className="text-[#1F2933]">How the time is estimated:</strong> {connection.distanceKm} km of mapped track at an assumed{' '}
              {d.breakdown.faster.mainKph}–{d.breakdown.slower.mainKph} km/h on main lines, plus stops (from {d.breakdown.faster.stops} short stops to one at each of the{' '}
              {d.breakdown.slower.stops} stations passed){d.breakdown.reversals > 0 ? `, and ${d.breakdown.reversals} change of direction` : ''}.
            </p>
            {connection.intermediateStations.length > 0 && (
              <p>
                <strong className="text-[#1F2933]">Stations along the mapped line:</strong>{' '}
                {connection.intermediateStations.slice(0, 12).map(s => s.code ?? s.name).join(', ')}
                {connection.intermediateStations.length > 12 ? ` and ${connection.intermediateStations.length - 12} more` : ''}. Whether a train stops at any of them is not known.
              </p>
            )}
            <ul className="list-disc space-y-1 pl-4">
              {assumptions.map(text => <li key={text}>{text}</li>)}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}

export type ExplorerCoords = { fromLat: number; fromLng: number; toLat: number; toLng: number };
export interface RailExplorerState { loading: boolean; data: RailExplorerResponse | null; error: string | null }

// Fetches estimated rail connections for two points (or takes the answer the search flow already fetched).
export function useRailExplorer(coords: ExplorerCoords | null, retry = 0): RailExplorerState {
  const key = coords ? explorerKey(coords) : '';
  const [state, setState] = useState<RailExplorerState>(() => {
    const cached = coords ? recallRailExplorer(key) : null;
    return cached ? { loading: false, data: cached, error: null } : { loading: Boolean(coords), data: null, error: null };
  });
  useEffect(() => {
    if (!coords) { setState({ loading: false, data: null, error: 'Choose places from the suggestions or on the map to see estimated rail connections.' }); return; }
    const cached = retry === 0 ? recallRailExplorer(key) : null;
    if (cached) { setState({ loading: false, data: cached, error: null }); return; }
    const controller = new AbortController();
    setState({ loading: true, data: null, error: null });
    fetchRailExplorer(coords, controller.signal)
      .then(data => setState({ loading: false, data, error: null }))
      .catch(error => { if (!controller.signal.aborted) setState({ loading: false, data: null, error: (error as Error).message }); });
    return () => controller.abort();
  }, [key, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// The cards, or one plain sentence saying why there are none (network not ready, no station nearby, not connected...).
export function EstimatedRailList({ state, loadingText = 'Looking at the mapped railway network…' }: { state: RailExplorerState; loadingText?: string }) {
  const connections = state.data?.connections ?? [];
  const message = state.error ?? state.data?.reason ?? state.data?.message ?? null;
  return (
    <div className="space-y-4">
      {state.loading && <p role="status" className="text-sm text-[#667085]">{loadingText}</p>}
      {!state.loading && connections.length === 0 && (
        <p role="status" className="rounded-xl border border-[#D9E2DE] bg-white px-4 py-3 text-sm text-[#475467]">{message ?? 'No estimated rail connection was found for these places.'}</p>
      )}
      {connections.map(connection => (
        <EstimatedRailCard key={connection.id} connection={connection} attribution={state.data?.network?.attribution ?? '© OpenStreetMap contributors'} assumptions={state.data?.assumptions ?? []} />
      ))}
    </div>
  );
}

// The one status label every estimated railway card carries (no further disclaimers on the card itself).
export const ESTIMATED_STATUS = 'Estimated — no verified train schedule';
export const ESTIMATED_SECTION_TITLE = 'Train suggestions';
export const ESTIMATED_SECTION_INTRO = 'Estimated from mapped railway connections. Schedules are not verified, so there are no departure times, train numbers or fares, and the date and time you searched do not apply.';

export function EstimatedRailHeading({ as = 'h2' }: { as?: 'h1' | 'h2' }) {
  const Title = as;
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EFF5FB] text-[#2F5D8C]"><MapPin aria-hidden className="h-5 w-5" /></span>
      <div>
        <Title id="estimated-rail-heading" className="text-xl font-black text-[#1F2933]">{ESTIMATED_SECTION_TITLE}</Title>
        <p className="text-sm text-[#667085]">{ESTIMATED_SECTION_INTRO}</p>
      </div>
    </div>
  );
}

// "No preference": its own section below the planned journeys, fetched independently so the journeys never wait for it.
export default function EstimatedRailSection({ coords }: { coords: ExplorerCoords | null }) {
  const state = useRailExplorer(coords);
  return (
    <section aria-labelledby="estimated-rail-heading" className="mt-10 space-y-4">
      <EstimatedRailHeading />
      <EstimatedRailList state={state} />
    </section>
  );
}
