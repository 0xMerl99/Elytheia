/**
 * Presentation-only pieces for the Home page redesign: the Olympus hero scene, laurel ornaments,
 * scroll-reveal and pointer effects. Nothing in here touches data, routing or app state.
 */
import {
  createElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';

/* ------------------------------------------------------------------ theme hook */

/** Marks <html> as "olympus" while the Home page is mounted (scopes every style in olympus.css) and tracks scroll for the glass header. */
export function useOlympusTheme() {
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.classList.add('olympus');
    const onScroll = () => {
      if (window.scrollY > 24) el.setAttribute('data-scrolled', '1');
      else el.removeAttribute('data-scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      el.classList.remove('olympus');
      el.removeAttribute('data-scrolled');
    };
  }, []);
}

/* ------------------------------------------------------------------ pointer glow */

const GLOW_TARGETS = '.coin-card, .king-main, .step, .chain-card, .stats-row, .cta-band';

/** Feeds the cursor position to whichever glass surface it is over (drives the gold spotlight on hover). */
export function glowPointer(e: PointerEvent<HTMLElement>) {
  const hit = (e.target as HTMLElement).closest?.(GLOW_TARGETS) as HTMLElement | null;
  if (!hit) return;
  const r = hit.getBoundingClientRect();
  hit.style.setProperty('--mx', `${e.clientX - r.left}px`);
  hit.style.setProperty('--my', `${e.clientY - r.top}px`);
}

/* ------------------------------------------------------------------ scroll reveal */

export function Reveal({
  as = 'div',
  delay = 0,
  className = '',
  children,
  ...rest
}: {
  as?: 'div' | 'section';
  delay?: number;
  className?: string;
  children: ReactNode;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.04 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return createElement(
    as,
    { ref, className: `reveal${shown ? ' in' : ''} ${className}`.trim(), style: { '--d': `${delay}ms` } as CSSProperties, ...rest },
    children,
  );
}

/* ------------------------------------------------------------------ seeded noise */

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ laurel */

/** Open laurel wreath (two mirrored branches). Colour comes from the shared brand gold gradient. */
export function Laurel({ className }: { className?: string }) {
  const id = useId();
  const leaves = useMemo(() => {
    const out: { x: number; y: number; r: number; s: number }[] = [];
    const N = 11;
    const R = 35;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const phi = ((100 - t * 165) * Math.PI) / 180;
      const x = 50 + R * Math.cos(phi);
      const y = 50 + R * Math.sin(phi);
      const travel = (phi * 180) / Math.PI - 90;
      const s = 1 - t * 0.35;
      out.push({ x, y, r: travel - 38, s }, { x, y, r: travel + 38, s: s * 0.88 });
    }
    return out;
  }, []);
  const a = (100 * Math.PI) / 180;
  const b = (-65 * Math.PI) / 180;
  const stem = `M${(50 + 35 * Math.cos(a)).toFixed(2)} ${(50 + 35 * Math.sin(a)).toFixed(2)} A35 35 0 0 0 ${(50 + 35 * Math.cos(b)).toFixed(2)} ${(50 + 35 * Math.sin(b)).toFixed(2)}`;
  const branch = (
    <>
      <path d={stem} fill="none" stroke={`url(#${id})`} strokeWidth="1.1" strokeLinecap="round" />
      {leaves.map((l, i) => (
        <path
          key={i}
          d="M0 0C2.5-3.4 8-3.6 12 0C8 3.6 2.5 3.4 0 0Z"
          fill={`url(#${id})`}
          transform={`translate(${l.x.toFixed(2)} ${l.y.toFixed(2)}) rotate(${l.r.toFixed(1)}) scale(${l.s.toFixed(2)})`}
        />
      ))}
    </>
  );
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6dc9a" />
          <stop offset=".55" stopColor="#e2b25a" />
          <stop offset="1" stopColor="#c98f34" />
        </linearGradient>
      </defs>
      <g>{branch}</g>
      <g transform="translate(100 0) scale(-1 1)">{branch}</g>
    </svg>
  );
}

/* ------------------------------------------------------------------ columns */

/** A fluted marble shaft with capital, drawn in a gradient set defined once by the parent SVG (ids prefixed with `p`). */
function Column({ p, x, y, w, h, rim }: { p: string; x: number; y: number; w: number; h: number; rim: 'l' | 'r' }) {
  const top = w * 0.8;
  const flutes = [0.2, 0.4, 0.6, 0.8];
  const half = w / 2;
  const topHalf = top / 2;
  const cap = Math.max(5, w * 0.28);
  return (
    <g>
      {/* shaft with slight entasis */}
      <path d={`M${x - half} ${y + h} L${x - topHalf} ${y} L${x + topHalf} ${y} L${x + half} ${y + h}Z`} fill={`url(#${p}shaft)`} />
      {flutes.map((f) => (
        <line key={f} x1={x - half + w * f} y1={y + h} x2={x - topHalf + top * f} y2={y} stroke="#0b1226" strokeOpacity=".22" strokeWidth={Math.max(0.6, w * 0.035)} />
      ))}
      {/* gold rim light on the side facing the sun */}
      <line
        x1={rim === 'l' ? x - half : x + half}
        y1={y + h}
        x2={rim === 'l' ? x - topHalf : x + topHalf}
        y2={y}
        stroke="#f3cf7f"
        strokeOpacity=".7"
        strokeWidth={Math.max(0.8, w * 0.07)}
      />
      {/* echinus + abacus */}
      <path d={`M${x - topHalf} ${y} L${x - half * 1.1} ${y - cap * 0.55} L${x + half * 1.1} ${y - cap * 0.55} L${x + topHalf} ${y}Z`} fill={`url(#${p}shaft)`} />
      <rect x={x - half * 1.28} y={y - cap} width={w * 1.28} height={cap * 0.5} fill={`url(#${p}stone)`} />
    </g>
  );
}

function ColumnDefs({ p }: { p: string }) {
  return (
    <defs>
      <linearGradient id={`${p}shaft`} x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#f3efe4" />
        <stop offset=".3" stopColor="#c4c6cf" />
        <stop offset=".7" stopColor="#59618a" />
        <stop offset="1" stopColor="#1d2547" />
      </linearGradient>
      <linearGradient id={`${p}stone`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#e9e5da" />
        <stop offset="1" stopColor="#8c92ad" />
      </linearGradient>
    </defs>
  );
}

/* ------------------------------------------------------------------ hero art */

const CONSTELLATIONS: number[][][] = [
  [[210, 176], [290, 132], [372, 196], [455, 146], [540, 212], [600, 168]],
  [[1080, 126], [1166, 182], [1260, 142], [1330, 218], [1430, 170], [1494, 240]],
];

function Stars() {
  const stars = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 150 }, () => ({
      x: r() * 1600,
      y: Math.pow(r(), 1.5) * 760,
      r: 0.5 + r() * 1.1,
      o: 0.25 + r() * 0.65,
      tw: r() > 0.72,
      d: r() * 6,
    }));
  }, []);
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
      {stars.map((s, i) => (
        <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill="#dfe8ff" opacity={s.o.toFixed(2)} className={s.tw ? 'twinkle' : undefined} style={s.tw ? { animationDelay: `${s.d.toFixed(1)}s` } : undefined} />
      ))}
      {CONSTELLATIONS.map((c, i) => (
        <g key={i}>
          <polyline points={c.map((p) => p.join(',')).join(' ')} fill="none" stroke="#8fb0ff" strokeOpacity=".32" strokeWidth="1" />
          {c.map((p, j) => (
            <g key={j}>
              <circle cx={p[0]} cy={p[1]} r="7" fill="#6b9bff" opacity=".16" />
              <circle cx={p[0]} cy={p[1]} r="2.2" fill="#e6efff" />
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

function Halo() {
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <radialGradient id="o-sun" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff1c8" stopOpacity=".7" />
          <stop offset=".16" stopColor="#f3cf7f" stopOpacity=".42" />
          <stop offset=".5" stopColor="#d9a441" stopOpacity=".1" />
          <stop offset="1" stopColor="#d9a441" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="o-blue" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#4a7bff" stopOpacity=".3" />
          <stop offset="1" stopColor="#4a7bff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="1330" cy="230" r="420" fill="url(#o-blue)" />
      <circle cx="260" cy="330" r="360" fill="url(#o-blue)" opacity=".6" />
      <circle cx="800" cy="600" r="500" fill="url(#o-sun)" />
    </svg>
  );
}

function Rings() {
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
      <g className="ring-a">
        <circle cx="800" cy="600" r="250" fill="none" stroke="#f3cf7f" strokeOpacity=".3" />
        <circle cx="800" cy="600" r="262" fill="none" stroke="#f3cf7f" strokeOpacity=".5" strokeDasharray="1 9" />
        <circle cx="800" cy="600" r="378" fill="none" stroke="#f3cf7f" strokeOpacity=".16" />
        <circle cx="800" cy="600" r="392" fill="none" stroke="#f3cf7f" strokeOpacity=".26" strokeWidth="7" strokeDasharray="1.5 34" />
        <circle cx="800" cy="350" r="4" fill="#fff1c8" />
        <circle cx="1050" cy="600" r="3" fill="#f3cf7f" />
      </g>
      <g className="ring-b">
        <circle cx="800" cy="600" r="316" fill="none" stroke="#8fb0ff" strokeOpacity=".22" strokeDasharray="3 7" />
        <circle cx="800" cy="600" r="470" fill="none" stroke="#8fb0ff" strokeOpacity=".12" />
        <circle cx="484" cy="600" r="3.5" fill="#bcd0ff" />
        <circle cx="1096" cy="720" r="3" fill="#bcd0ff" />
      </g>
    </svg>
  );
}

function Peaks({ near }: { near?: boolean }) {
  if (near) {
    return (
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
        <defs>
          <linearGradient id="o-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0a1030" />
            <stop offset="1" stopColor="#04060d" />
          </linearGradient>
        </defs>
        <path d="M0 790 L100 748 L190 776 L290 716 L400 770 L500 744 L585 790 L640 822 L960 822 L1015 792 L1110 750 L1210 786 L1320 722 L1420 770 L1510 738 L1600 770 V900 H0Z" fill="url(#o-near)" />
        <path d="M0 790 L100 748 L190 776 L290 716 L400 770 L500 744 L585 790" fill="none" stroke="#f3cf7f" strokeOpacity=".22" />
        <path d="M1015 792 L1110 750 L1210 786 L1320 722 L1420 770 L1510 738 L1600 770" fill="none" stroke="#f3cf7f" strokeOpacity=".22" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <linearGradient id="o-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a2a5e" />
          <stop offset=".6" stopColor="#0d1638" />
          <stop offset="1" stopColor="#070c20" />
        </linearGradient>
        <linearGradient id="o-snow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f2e8" stopOpacity=".85" />
          <stop offset="1" stopColor="#c9d4f2" stopOpacity=".1" />
        </linearGradient>
        <linearGradient id="o-rim" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f3cf7f" stopOpacity="0" />
          <stop offset=".5" stopColor="#f3cf7f" stopOpacity=".85" />
          <stop offset="1" stopColor="#f3cf7f" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M0 712 L90 684 L170 702 L260 652 L340 678 L430 626 L520 658 L610 616 L690 590 L748 570 L800 542 L850 570 L905 588 L990 616 L1070 638 L1160 608 L1250 650 L1340 620 L1430 660 L1510 636 L1600 666 V900 H0Z"
        fill="url(#o-far)"
      />
      {/* snow on the summit */}
      <path d="M800 542 L752 570 L776 566 L791 583 L808 566 L830 582 L848 570Z" fill="url(#o-snow)" opacity=".8" />
      {/* sunlight skimming the ridge line */}
      <path d="M610 616 L690 590 L748 570 L800 542 L850 570 L905 588 L990 616" fill="none" stroke="url(#o-rim)" strokeWidth="1.6" />
    </svg>
  );
}

function Temple() {
  const p = 'ot-';
  const cols = Array.from({ length: 8 }, (_, i) => 800 + (i - 3.5) * 78);
  const Y0 = 860;
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" focusable="false">
      <ColumnDefs p={p} />
      <g transform="translate(0 -52)">
      <defs>
        <linearGradient id="ot-ped" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#efebe0" />
          <stop offset="1" stopColor="#9aa0bb" />
        </linearGradient>
        <linearGradient id="ot-tym" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2650" />
          <stop offset="1" stopColor="#0b1230" />
        </linearGradient>
        <radialGradient id="ot-eye" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff1c8" />
          <stop offset=".5" stopColor="#f3cf7f" />
          <stop offset="1" stopColor="#f3cf7f" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* the dark interior behind the colonnade */}
      <rect x="520" y="738" width="560" height={Y0 - 738} fill="#050818" />
      {/* steps */}
      <rect x="478" y="874" width="644" height="8" fill="url(#ot-ped)" opacity=".62" />
      <rect x="492" y="867" width="616" height="7" fill="url(#ot-ped)" opacity=".8" />
      <rect x="505" y="860" width="590" height="7" fill="url(#ot-ped)" />
      {cols.map((x, i) => (
        <Column key={i} p={p} x={x} y={Y0 - 112} w={22} h={112} rim={x < 800 ? 'r' : 'l'} />
      ))}
      {/* entablature: architrave, frieze with triglyphs, cornice */}
      <rect x="505" y="722" width="590" height="16" fill="url(#ot-ped)" />
      <rect x="505" y="706" width="590" height="16" fill="#cfd2dd" />
      {Array.from({ length: 16 }, (_, i) => (
        <rect key={i} x={512 + i * 36.5} y="708" width="7" height="12" fill="#2a3358" opacity=".85" />
      ))}
      <rect x="492" y="698" width="616" height="8" fill="url(#ot-ped)" />
      {/* pediment */}
      <path d="M484 698 L800 628 L1116 698Z" fill="url(#ot-ped)" />
      <path d="M522 692 L800 634 L1078 692Z" fill="url(#ot-tym)" />
      <path d="M484 698 L800 628 L1116 698" fill="none" stroke="#f3cf7f" strokeOpacity=".75" strokeWidth="1.4" />
      <circle cx="800" cy="668" r="22" fill="url(#ot-eye)" />
      <circle cx="800" cy="668" r="5" fill="#fff6dc" />
      </g>
    </svg>
  );
}

function ForegroundColumn() {
  return (
    <svg viewBox="0 0 100 800" preserveAspectRatio="none" focusable="false">
      <defs>
        <linearGradient id="of-shaft" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#03050c" />
          <stop offset=".62" stopColor="#0a1030" />
          <stop offset=".93" stopColor="#222e62" />
          <stop offset=".985" stopColor="#4d5b92" />
          <stop offset="1" stopColor="#b8964e" />
        </linearGradient>
        <linearGradient id="of-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#05070f" stopOpacity=".55" />
          <stop offset=".3" stopColor="#05070f" stopOpacity="0" />
          <stop offset=".75" stopColor="#05070f" stopOpacity="0" />
          <stop offset="1" stopColor="#05070f" stopOpacity=".92" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="100" height="800" fill="url(#of-shaft)" />
      {[16, 32, 48, 64, 80].map((x) => (
        <g key={x}>
          <line x1={x} y1="0" x2={x} y2="800" stroke="#000" strokeOpacity=".45" strokeWidth="2.4" />
          <line x1={x + 3} y1="0" x2={x + 3} y2="800" stroke="#9db4f5" strokeOpacity=".09" strokeWidth="1.4" />
        </g>
      ))}
      <rect x="0" y="0" width="100" height="800" fill="url(#of-fade)" />
    </svg>
  );
}

const MOTES = Array.from({ length: 16 }, (_, i) => {
  const r = rng(31 + i);
  return { left: 6 + r() * 88, size: 1.5 + r() * 2.5, dur: 14 + r() * 14, delay: -r() * 24, drift: (r() - 0.5) * 80 };
});

/** Decorative hero scene: sky, stars, halo, Olympus, temple and framing columns, with pointer + scroll parallax. */
export function HeroArt() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const tick = () => {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      el.style.setProperty('--px', cx.toFixed(3));
      el.style.setProperty('--py', cy.toFixed(3));
      el.style.setProperty('--sy', Math.min(window.scrollY, 1200).toFixed(1));
      raf = Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
      kick();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('scroll', kick, { passive: true });
    kick();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', kick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="hero-art" ref={root} aria-hidden="true">
      <div className="hl sky" />
      <div className="hl l-stars"><Stars /></div>
      <span className="shoot" />
      <div className="hl l-halo"><Halo /></div>
      <div className="hl l-far"><Peaks /></div>
      <div className="hl l-rings"><Rings /></div>
      <div className="hl l-near"><Peaks near /></div>
      <div className="hl l-temple"><Temple /></div>
      <div className="hero-mist" />
      <div className="motes">
        {MOTES.map((m, i) => (
          <i
            key={i}
            style={{ left: `${m.left}%`, width: m.size, height: m.size, animationDuration: `${m.dur}s`, animationDelay: `${m.delay}s`, '--drift': `${m.drift}px` } as CSSProperties}
          />
        ))}
      </div>
      <div className="hl l-fg fg-left"><ForegroundColumn /></div>
      <div className="hl l-fg fg-right"><ForegroundColumn /></div>
      <div className="hero-glow" />
      <div className="hero-vignette" />
    </div>
  );
}

/* ------------------------------------------------------------------ call-to-action art */

export function CtaArt() {
  const p = 'oc-';
  const left = [
    { x: 64, h: 400 },
    { x: 150, h: 320 },
  ];
  return (
    <svg className="cta-art" viewBox="0 0 1200 520" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <ColumnDefs p={p} />
      <defs>
        <radialGradient id="oc-sun" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff1c8" stopOpacity=".75" />
          <stop offset=".3" stopColor="#f3cf7f" stopOpacity=".32" />
          <stop offset="1" stopColor="#d9a441" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="600" cy="540" r="420" fill="url(#oc-sun)" />
      <g className="ring-a" style={{ transformOrigin: '600px 540px' }}>
        <circle cx="600" cy="540" r="190" fill="none" stroke="#f3cf7f" strokeOpacity=".3" />
        <circle cx="600" cy="540" r="204" fill="none" stroke="#f3cf7f" strokeOpacity=".45" strokeDasharray="1 9" />
        <circle cx="600" cy="540" r="300" fill="none" stroke="#f3cf7f" strokeOpacity=".16" />
      </g>
      <g opacity=".55">
        {left.map((c) => (
          <Column key={`l${c.x}`} p={p} x={c.x} y={520 - c.h} w={34} h={c.h} rim="r" />
        ))}
        {left.map((c) => (
          <Column key={`r${c.x}`} p={p} x={1200 - c.x} y={520 - c.h} w={34} h={c.h} rim="l" />
        ))}
      </g>
    </svg>
  );
}
