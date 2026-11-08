import { useEffect, useRef, useState } from 'react';
import type { Coin } from './types';

export type StreamEvent =
  | { type: 'hello' }
  | {
      type: 'trade';
      coinId: string;
      graduated?: boolean;
      trade: { id: number; side: 'buy' | 'sell'; quote: number; tokens: number; price: number; user?: string; createdAt: number; sig: string };
    }
  | { type: 'launch'; coins: Coin[] }
  | { type: 'meta'; coinId: string };

type Handler = (e: StreamEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;

function ensure() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/stream');
  source.onmessage = (m) => {
    try {
      const data = JSON.parse(m.data) as StreamEvent;
      handlers.forEach((h) => h(data));
    } catch {
      /* ignore malformed frames */
    }
  };
}

/** Subscribe to the shared server-sent-event connection while the component is mounted. */
export function useStream(handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h: Handler = (e) => ref.current(e);
    handlers.add(h);
    ensure();
    return () => {
      handlers.delete(h);
      if (handlers.size === 0 && source) {
        source.close();
        source = null;
      }
    };
  }, []);
}

/** Re-renders on an interval; handy for "5s ago" labels. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
