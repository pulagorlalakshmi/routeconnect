import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ArrowRightLeft, Bus, Route, Sparkles, TrainFront, Waypoints, Wallet, X, Zap } from 'lucide-react';
import RouteMotionBackdrop from './RouteMotionBackdrop';
import { DEFAULT_PREFERENCES, MODE_CHOICES, RANKING_OPTIONS, modeChoiceOf } from '../utils/travelPreferences';
import type { ModeChoiceId, RankingPreference, TravelPreferences } from '../utils/travelPreferences';

// The one question asked after "Find routes": how should we choose your routes? Everything is pre-filled (the last
// choice, or "No preference" + "Best overall"), so a single click on "Show routes" — or "Skip" — is enough.
//
// Accessibility: role="dialog" + aria-modal, labelled by its title; focus moves into the dialog and is kept there;
// Escape and "Back" close it and return focus to the button that opened it; the page behind is made inert and does not
// scroll. Train choices are shown but disabled until a verified railway timetable is connected.

const MODE_ICON: Record<ModeChoiceId, ReactNode> = {
  any: <Route aria-hidden className="h-5 w-5" />,
  bus: <Bus aria-hidden className="h-5 w-5" />,
  train: <TrainFront aria-hidden className="h-5 w-5" />,
  bus_train: <Waypoints aria-hidden className="h-5 w-5" />
};

const RANK_ICON: Record<RankingPreference, ReactNode> = {
  best: <Sparkles aria-hidden className="h-4 w-4" />,
  fastest: <Zap aria-hidden className="h-4 w-4" />,
  cost: <Wallet aria-hidden className="h-4 w-4" />,
  transfers: <ArrowRightLeft aria-hidden className="h-4 w-4" />
};

const TRAIN_NOTE = 'Train timetables are not connected yet, so we never show train journeys. Coming soon.';

export interface PreferenceModalProps {
  open: boolean;
  initial: TravelPreferences;
  trip?: { from: string; to: string; when?: string };
  onConfirm: (preferences: TravelPreferences) => void;
  onClose: () => void;
  // When set (the search is running, or failed), it replaces the dialog inside the SAME overlay: the blurred page and
  // the route motion stay put, so choosing preferences flows straight into finding routes. Escape still calls onClose.
  stage?: ReactNode;
  stageLabel?: string;
}

// The choice to pre-select: the remembered one when it is available, otherwise "No preference".
const seedModes = (modes: TravelPreferences['modes']) => {
  const choice = modeChoiceOf(modes);
  return choice.available ? choice.modes : [];
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export default function PreferenceModal({ open, initial, trip, onConfirm, onClose, stage, stageLabel = 'Finding routes' }: PreferenceModalProps) {
  const [modes, setModes] = useState(() => seedModes(initial.modes));
  const [ranking, setRanking] = useState<RankingPreference>(initial.ranking);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const uid = useId();
  const titleId = `pref-title-${uid}`;
  const descriptionId = `pref-desc-${uid}`;
  const modeName = `pref-mode-${uid}`;
  const rankName = `pref-rank-${uid}`;

  // Re-seed the draft every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setModes(seedModes(initial.modes));
    setRanking(initial.ranking);
  }, [open, initial]);

  // Focus, Escape, focus trap, inert background and scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    const previousOverflow = document.body.style.overflow;
    root?.setAttribute('inert', '');
    root?.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const checked = dialogRef.current?.querySelector<HTMLInputElement>(`input[name="${modeName}"]:checked`);
      (checked ?? dialogRef.current)?.focus();
    }, 30);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        // Only the checked radio of each group is a Tab stop.
        .filter(el => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [open, modeName]);

  if (!open) return null;

  const selectedChoice = modeChoiceOf(modes);
  const confirm = () => onConfirm({ modes: selectedChoice.available ? selectedChoice.modes : [], ranking });

  const content = (
    <div className="rc-pref-overlay fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-6">
      {/* Blurred, tinted page + slow route motion. Clicking it is the same as "Back". */}
      <div className="absolute inset-0 bg-[#0F2A25]/55 backdrop-blur-md" onClick={stage ? undefined : onClose} aria-hidden="true" />
      <RouteMotionBackdrop />

      {stage ? (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={stageLabel} className="relative mx-4 mb-4 w-full self-center sm:mx-0 sm:mb-0 sm:max-w-md">
          {stage}
        </div>
      ) : (
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="rc-pref-dialog relative w-full max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-t-3xl bg-white shadow-2xl shadow-black/30 outline-none sm:max-w-lg sm:rounded-3xl"
      >
        <div className="px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-[#146B5B]">Almost there</p>
              <h2 id={titleId} className="mt-1.5 text-2xl font-black tracking-tight text-[#1F2933]">Any preferences?</h2>
              <p id={descriptionId} className="mt-1 text-sm text-[#667085]">Pick what matters, or keep the defaults.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to search"
              className="-mr-1 -mt-1 shrink-0 rounded-full p-2 text-[#667085] transition hover:bg-[#F1F4F3] hover:text-[#1F2933] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {trip && (
            <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-[#F1F4F3] px-3.5 py-2.5 text-sm font-bold text-[#1F2933]">
              <span className="truncate">{trip.from}</span>
              <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-[#146B5B]" />
              <span className="truncate">{trip.to}</span>
              {trip.when && <span className="font-semibold text-[#667085]">· {trip.when}</span>}
            </p>
          )}

          <fieldset className="mt-5">
            <legend className="text-xs font-extrabold uppercase tracking-wider text-[#667085]">Travel by</legend>
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {MODE_CHOICES.map((option, i) => {
                const inputId = `${modeName}-${option.id}`;
                const checked = option.available && selectedChoice.id === option.id;
                return (
                  <label
                    key={option.id}
                    htmlFor={inputId}
                    style={{ ['--i' as string]: i }}
                    className={`rc-pref-option group relative flex items-start gap-3 rounded-2xl border p-3.5 transition ${
                      !option.available
                        ? 'cursor-not-allowed border-[#E4E9E6] bg-[#FAFBFA]'
                        : checked
                          ? 'cursor-pointer border-[#146B5B] bg-[#EEF6F3] shadow-sm shadow-[#146B5B]/10'
                          : 'cursor-pointer border-[#D9E2DE] bg-white hover:-translate-y-px hover:border-[#9DBFB5] hover:shadow-sm'
                    } focus-within:ring-2 focus-within:ring-[#146B5B]/40`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name={modeName}
                      value={option.id}
                      checked={checked}
                      disabled={!option.available}
                      aria-describedby={option.available ? undefined : `${modeName}-train-note`}
                      onChange={() => setModes(option.modes)}
                      className="sr-only"
                    />
                    <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
                      !option.available ? 'bg-[#F2F4F7] text-[#98A2B3]' : checked ? 'bg-[#146B5B] text-white' : 'bg-[#EEF6F3] text-[#146B5B]'
                    }`}>
                      {MODE_ICON[option.id]}
                    </span>
                    <span className="min-w-0">
                      <span className={`flex flex-wrap items-center gap-1.5 text-sm font-extrabold ${option.available ? 'text-[#1F2933]' : 'text-[#98A2B3]'}`}>
                        {option.label}
                        {!option.available && (
                          <span className="rounded-md bg-[#F2F4F7] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#667085]">Coming soon</span>
                        )}
                      </span>
                      <span className={`mt-0.5 block text-xs leading-snug ${option.available ? 'text-[#667085]' : 'text-[#98A2B3]'}`}>{option.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {MODE_CHOICES.some(option => !option.available) && (
              <p id={`${modeName}-train-note`} className="mt-2 text-xs text-[#667085]">{TRAIN_NOTE}</p>
            )}
          </fieldset>

          <fieldset className="mt-5">
            <legend className="text-xs font-extrabold uppercase tracking-wider text-[#667085]">Show first</legend>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {RANKING_OPTIONS.map((option, i) => {
                const inputId = `${rankName}-${option.id}`;
                const checked = ranking === option.id;
                return (
                  <label
                    key={option.id}
                    htmlFor={inputId}
                    style={{ ['--i' as string]: i + MODE_CHOICES.length }}
                    className={`rc-pref-option flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold transition focus-within:ring-2 focus-within:ring-[#146B5B]/40 ${
                      checked ? 'border-[#146B5B] bg-[#EEF6F3] text-[#146B5B]' : 'border-[#D9E2DE] bg-white text-[#1F2933] hover:border-[#9DBFB5]'
                    }`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name={rankName}
                      value={option.id}
                      checked={checked}
                      onChange={() => setRanking(option.id)}
                      className="sr-only"
                    />
                    <span className={checked ? 'text-[#146B5B]' : 'text-[#667085]'}>{RANK_ICON[option.id]}</span>
                    {option.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-[#EEF1EF] bg-white/95 px-5 py-4 backdrop-blur sm:flex sm:items-center sm:px-7">
          <button
            type="button"
            onClick={() => onConfirm({ ...DEFAULT_PREFERENCES, modes: [] })}
            className="order-3 rounded-xl px-3 py-2.5 text-sm font-bold text-[#667085] transition hover:text-[#1F2933] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B] sm:order-none sm:mr-auto sm:px-2"
          >
            Skip, no preference
          </button>
          <button
            type="button"
            onClick={onClose}
            className="order-2 rounded-xl border border-[#D0D9D5] bg-white px-5 py-3 text-sm font-bold text-[#1F2933] transition hover:bg-[#F7FAF9] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={confirm}
            className="order-1 col-span-2 inline-flex items-center justify-center gap-2 rounded-xl bg-[#146B5B] px-6 py-3 text-sm font-extrabold text-white shadow-md shadow-[#146B5B]/25 transition hover:bg-[#0f5447] hover:shadow-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-[#146B5B]/30"
          >
            Show routes
            <ArrowRight aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>
      )}
    </div>
  );

  // In the browser the dialog sits on <body>, outside the (inert) app root; server rendering (tests) renders it inline.
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
