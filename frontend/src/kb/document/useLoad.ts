import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api/client';

export type Loaded<T> =
  | { load: 'loading'; value: T | null }
  | { load: 'ready'; value: T }
  | { load: 'error'; value: T | null; error: string };

/**
 * Load `fetch()` for `key`, keep the last value while reloading, ignore answers for an old key.
 * `reload()` re-runs it; `set()` replaces the value with a fresher one from an action's answer.
 */
export function useLoad<T>(key: string | null, fetch: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ load: 'loading', value: null });
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const generation = useRef(0);

  const run = useCallback((keepValue: boolean) => {
    const id = ++generation.current;
    setState((s) => ({ load: 'loading', value: keepValue ? s.value : null }));
    fetchRef.current().then(
      (value) => { if (id === generation.current) setState({ load: 'ready', value }); },
      (error: unknown) => {
        if (id === generation.current) setState((s) => ({ load: 'error', value: keepValue ? s.value : null, error: errorText(error) }));
      },
    );
  }, []);

  useEffect(() => {
    if (key === null) return undefined;
    run(false);
    return () => { generation.current += 1; };
  }, [key, run]);

  const reload = useCallback(() => run(true), [run]);
  const set = useCallback((value: T) => {
    generation.current += 1;
    setState({ load: 'ready', value });
  }, []);
  return { state, reload, set };
}

/** Call `tick` every `ms` while `active`; stops on unmount. */
export function useInterval(active: boolean, ms: number, tick: () => void) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}
