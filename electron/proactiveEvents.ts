// Electron main follows the backend's proactive push feed (issue #10).
//
// The renderer's timers are throttled while SKAZ is in the background, which is
// exactly when a "you're being asked" notification matters. Main is not
// throttled: it long-polls GET /proactive/events and, the moment a card appears,
// shows the content-free notification and tells the window to refresh. The feed
// carries session ids and counts only, never card text. Kept free of Electron
// imports so the loop is unit-tested with a fake backend.

export interface ProactiveChange { session_id: string; new_cards: number }
export interface ProactiveFeed { seq: number; changes: ProactiveChange[]; sound: boolean }

export interface ProactiveWatcherDeps {
  handle: () => { port: number; token: string } | null;
  fetchFeed: (url: string, token: string, signal: AbortSignal) => Promise<ProactiveFeed>;
  /** Sessions whose cards changed: the window refetches them at once. */
  onChanges: (sessionIds: string[]) => void;
  /** At least one new card appeared. */
  onNewCards: (sound: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const PROACTIVE_WAIT_S = 25;
const IDLE_MS = 1000;
const MAX_BACKOFF_MS = 5000;

export function feedUrl(port: number, after: number): string {
  const wait = after < 0 ? 0 : PROACTIVE_WAIT_S;
  return `http://127.0.0.1:${port}/proactive/events?after=${after}&timeout=${wait}`;
}

export function isFeed(value: unknown): value is ProactiveFeed {
  if (typeof value !== 'object' || value === null) return false;
  const feed = value as Record<string, unknown>;
  return Number.isSafeInteger(feed.seq) && Array.isArray(feed.changes) && feed.changes.every((change) =>
    typeof change === 'object' && change !== null
    && typeof (change as Record<string, unknown>).session_id === 'string'
    && Number.isSafeInteger((change as Record<string, unknown>).new_cards));
}

export class ProactiveWatcher {
  private running = false;
  private abort: AbortController | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ProactiveWatcherDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    // -1: learn the current position first; cards that existed before are not announced.
    let after = -1;
    let failures = 0;
    while (this.running) {
      const handle = this.deps.handle();
      if (!handle) {
        after = -1;
        await this.sleep(IDLE_MS);
        continue;
      }
      this.abort = new AbortController();
      try {
        const feed = await this.deps.fetchFeed(feedUrl(handle.port, after), handle.token, this.abort.signal);
        if (!isFeed(feed)) throw new Error('invalid proactive feed');
        if (after >= 0 && feed.changes.length) {
          this.deps.onChanges(feed.changes.map((change) => change.session_id));
          if (feed.changes.some((change) => change.new_cards > 0)) this.deps.onNewCards(feed.sound === true);
        }
        after = feed.seq;
        failures = 0;
      } catch {
        if (!this.running) break;
        failures += 1;
        after = -1;
        await this.sleep(Math.min(MAX_BACKOFF_MS, 250 * 2 ** failures));
      } finally {
        this.abort = null;
      }
    }
  }
}
