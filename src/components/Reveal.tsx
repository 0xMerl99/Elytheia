import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Fades a section up the first time it scrolls into view. Presentation only; shows immediately without IntersectionObserver. */
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
      { rootMargin: '0px 0px -4% 0px', threshold: 0.02 },
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
