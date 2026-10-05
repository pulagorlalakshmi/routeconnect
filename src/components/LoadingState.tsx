import { Loader2 } from 'lucide-react';

export default function LoadingState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-[#D9DED9] bg-white p-10 text-center shadow-sm" role="status" aria-live="polite">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#E8F1EE] text-[#146B5B]">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
      <p className="mt-5 text-base font-bold text-[#1F2933]">{label}</p>
      <p className="mt-2 max-w-xl mx-auto text-sm leading-6 text-[#667085]">
        Checking the published timetable for services that fit your date and time.
      </p>
    </div>
  );
}
