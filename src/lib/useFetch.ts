import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: (silent?: boolean) => void;
  setData: (d: T | null | ((prev: T | null) => T | null)) => void;
}

/** Tiny data-fetching hook: keeps stale data on screen while reloading and ignores out-of-order responses. */
export function useFetch<T>(path: string | null, deps: unknown[] = []): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const seq = useRef(0);

  const run = useCallback(
    (silent = false) => {
      if (!path) return;
      const my = ++seq.current;
      if (!silent) setLoading(true);
      api<T>(path)
        .then((d) => {
          if (my !== seq.current) return;
          setData(d);
          setError(null);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setError(e?.message || 'Something went wrong');
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, ...deps],
  );

  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current !== path) {
      // navigating to a different resource: never show the previous one's data under the new URL
      lastPath.current = path;
      setData(null);
      setError(null);
    }
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    run();
    return () => {
      seq.current++;
    };
  }, [run, path]);

  return { data, error, loading, reload: run, setData };
}
