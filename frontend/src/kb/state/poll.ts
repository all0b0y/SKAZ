/**
 * Long poll with a cursor (API-B2 transport): ask for news after `cursor`, waiting up to `WAIT_S`
 * seconds on the backend. A quick answer without news means the backend does not hold the request
 * (older routes answer at once) — then the loop pauses instead of spinning. Errors back off.
 * Returns `stop`; nothing runs after it.
 */
export const WAIT_S = 25;
const QUICK_MS = 1000;
const IDLE_MS = 3000;
const ERROR_MIN_MS = 2000;
const ERROR_MAX_MS = 30_000;

export interface PollStep<C> {
  cursor: C;
  /** True when the answer carried news (then the next request goes out at once). */
  changed: boolean;
  /** Nothing more will come (a finished task): the loop ends by itself. */
  done?: boolean;
}

export function longPoll<C>(
  step: (cursor: C, wait: number) => Promise<PollStep<C>>,
  initial: C,
  { now = () => Date.now(), sleep = defaultSleep }: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let cursor = initial;
  let errorDelay = ERROR_MIN_MS;
  void (async () => {
    while (!signal.aborted) {
      const started = now();
      try {
        const result = await step(cursor, WAIT_S);
        if (signal.aborted) return;
        cursor = result.cursor;
        errorDelay = ERROR_MIN_MS;
        if (result.done) return;
        if (!result.changed && now() - started < QUICK_MS) await sleep(IDLE_MS, signal);
      } catch {
        if (signal.aborted) return;
        await sleep(errorDelay, signal);
        errorDelay = Math.min(ERROR_MAX_MS, errorDelay * 2);
      }
    }
  })();
  return () => controller.abort();
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
