// Centralized quit/close authorization for the main process. Pure and free of
// Electron imports so the actual event orchestration can be unit-tested.
//
// The bugs this fixes (docs/FRONTEND-FIX-REPORT.md reviews):
//  - before-quit stopped the backend BEFORE the user confirmed, so cancelling
//    Cmd+Q left a live recording UI talking to a dead backend;
//  - quit was allowed the instant a shutdown *started*, so a repeated Cmd+Q
//    during the drain could quit the app before the backend actually stopped;
//  - a rejected stopBackend left an unhandled rejection and a stuck state where
//    the app would never quit.
//
// Guarantees now: the warning dialog always runs BEFORE any shutdown; a cancel
// preserves the running backend; quit reentry is blocked until the shutdown has
// actually SETTLED (resolved or rejected); a rejected stop is handled explicitly
// (reported, then the app still quits) with no unhandled rejection.

export interface QuitDeps {
  /** Is there audio worth protecting (recording/draining/failed)? */
  hasUnsentAudio: () => boolean;
  /** Show the blocking warning. Returns true if the user chose to discard + quit. */
  confirmDiscard: () => boolean;
  /** Tear the backend down. Called at most once, only after authorization. */
  stopBackend: () => Promise<void>;
  /** Re-issue the real application quit once shutdown has settled. */
  quit: () => void;
  /** Report a shutdown failure (optional). The app still quits afterwards. */
  onShutdownError?: (error: unknown) => void;
}

type Phase = 'idle' | 'draining' | 'settled';

export class QuitController {
  private phase: Phase = 'idle';
  private authorized = false;
  private deciding = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly deps: QuitDeps) {}

  get isShuttingDown(): boolean {
    return this.phase === 'draining';
  }

  /** Wire to app 'before-quit'. Returns true when the caller must preventDefault. */
  onBeforeQuit(): boolean {
    if (this.phase === 'settled') return false; // shutdown finished → let the real quit proceed
    if (this.phase === 'draining') return true; // shutdown in progress → keep blocking
    if (!this.decide()) return true; // cancelled or a dialog is open → block, stay alive
    this.beginShutdown();
    return true; // block this quit; we re-issue it once the shutdown settles
  }

  /** Wire to the main window 'close'. Returns true when the caller must preventDefault. */
  onWindowClose(): boolean {
    if (this.phase !== 'idle') return false; // draining/settled → let the close through
    if (!this.deps.hasUnsentAudio()) return false; // nothing to protect → allow
    if (!this.decide()) return true; // cancelled → block, backend preserved
    this.beginShutdown();
    return true;
  }

  /** Resolves once any in-flight shutdown finishes (test + teardown helper). */
  settled(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  // Synchronous authorization gate. Returns true only when quit is allowed.
  private decide(): boolean {
    if (this.authorized) return true;
    if (this.deps.hasUnsentAudio()) {
      if (this.deciding) return false; // a decision is already in progress → no duplicate dialog
      this.deciding = true;
      let discard: boolean;
      try {
        discard = this.deps.confirmDiscard();
      } finally {
        this.deciding = false;
      }
      if (!discard) return false; // user kept recording → backend stays running
    }
    this.authorized = true;
    return true;
  }

  private beginShutdown(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'draining';
    // Invoke stopBackend synchronously (so the drain truly starts now), but wrap
    // it so a synchronous throw becomes a rejection. The chained handler ensures
    // a rejected stop never escapes as an unhandled rejection and never leaves
    // the app stuck mid-drain: report it, then still quit.
    let stopPromise: Promise<void>;
    try {
      stopPromise = Promise.resolve(this.deps.stopBackend());
    } catch (err) {
      stopPromise = Promise.reject(err);
    }
    this.pending = stopPromise.then(
      () => this.finishAndQuit(),
      (err: unknown) => {
        this.deps.onShutdownError?.(err);
        this.finishAndQuit();
      },
    );
  }

  private finishAndQuit(): void {
    this.phase = 'settled';
    this.deps.quit();
  }
}
