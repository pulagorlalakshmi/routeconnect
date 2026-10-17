import { prefersReducedMotion } from '../utils/trackingLaunch';

// Decorative, map-like motion behind the preference dialog: a few dotted routes that slowly flow, softly pulsing stops
// and two small "vehicles" gliding along a route. Pure SVG + CSS (index.css, rc-pref-*), a handful of elements, no
// per-frame JavaScript. Under prefers-reduced-motion everything is static and the vehicles are not rendered.
const ROUTES = [
  'M-40 620 C 180 560, 260 420, 470 430 S 820 560, 1010 470 S 1180 300, 1260 320',
  'M-60 180 C 140 220, 300 120, 520 190 S 860 330, 1020 230 S 1180 120, 1270 150',
  'M160 860 C 220 700, 360 640, 520 660 S 760 760, 900 690 S 1080 520, 1250 560',
  'M760 -40 C 720 120, 820 220, 760 360 S 640 560, 700 700 S 820 840, 800 880'
];

const STOPS: [number, number][] = [
  [470, 430], [1010, 470], [520, 190], [1020, 230], [520, 660], [900, 690], [760, 360], [700, 700]
];

export default function RouteMotionBackdrop({ animate = !prefersReducedMotion() }: { animate?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="rc-pref-backdrop pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
    >
      <g className="rc-pref-drift">
        {ROUTES.map((d, i) => (
          <g key={d}>
            <path d={d} fill="none" stroke="#9BE3CF" strokeOpacity="0.14" strokeWidth="10" strokeLinecap="round" />
            <path
              d={d}
              fill="none"
              stroke="#C8F2E6"
              strokeOpacity="0.55"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="rc-pref-flow"
              style={{ animationDuration: `${16 + i * 4}s` }}
            />
          </g>
        ))}
        {STOPS.map(([x, y], i) => (
          <g key={`${x}-${y}`} className="rc-pref-node" style={{ animationDelay: `${i * 0.45}s` }}>
            <circle cx={x} cy={y} r="11" fill="#9BE3CF" fillOpacity="0.16" />
            <circle cx={x} cy={y} r="4.5" fill="#E8FBF5" fillOpacity="0.85" />
          </g>
        ))}
        {animate && [0, 2].map((routeIndex, i) => (
          <g key={routeIndex} className="rc-pref-mover">
            <circle r="9" fill="#F2C76B" fillOpacity="0.25">
              <animateMotion dur={`${22 + i * 6}s`} repeatCount="indefinite" path={ROUTES[routeIndex]} begin={`${-i * 7}s`} />
            </circle>
            <circle r="4" fill="#F2C76B">
              <animateMotion dur={`${22 + i * 6}s`} repeatCount="indefinite" path={ROUTES[routeIndex]} begin={`${-i * 7}s`} />
            </circle>
          </g>
        ))}
      </g>
    </svg>
  );
}
