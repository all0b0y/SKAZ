/**
 * Autosave for the note editor.
 *
 * With note versions gone, the only thing standing between a user and a lost
 * lecture is that their text reaches disk on its own. So saving is not an action
 * the user performs: it happens ~2 s after they stop typing, and unconditionally
 * when the tab closes, the session changes, or the app quits. Cmd+S only makes it
 * happen sooner, and there is never a "save changes?" dialog — Obsidian has none,
 * and a dialog is just another way to lose text when it is dismissed.
 *
 * One save runs at a time. Text typed while a save is in flight is not dropped and
 * not raced: it is remembered and written immediately afterwards, so the last thing
 * the user typed is always the last thing stored.
 */

export const AUTOSAVE_DELAY_MS = 2_000;

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface AutosaveHandlers {
  save: (content: string) => Promise<void>;
  onStatus: (status: SaveStatus, error?: string) => void;
  delayMs?: number;
}

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string | null = null;
  private inFlight = false;
  /** Text typed during a save; written as soon as that save returns. */
  private queued: string | null = null;
  private disposed = false;

  constructor(private readonly handlers: AutosaveHandlers) {}

  /** The user typed. Schedules a save; does not start one yet. */
  change(content: string): void {
    if (this.disposed) return;
    this.pending = content;
    this.handlers.onStatus('dirty');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.handlers.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  /** Save right now: Cmd+S, the save indicator, tab close, session change, quit. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending === null) return;
    if (this.inFlight) {
      // Never two writes of the same document at once; the newest text wins after.
      this.queued = this.pending;
      this.pending = null;
      return;
    }
    const content = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.handlers.onStatus('saving');
    try {
      await this.handlers.save(content);
      if (!this.disposed) this.handlers.onStatus('saved');
    } catch (error) {
      // The text stays in the editor and stays dirty: a failed write must never
      // look like a successful one, and must never discard what the user wrote.
      if (!this.disposed) {
        this.pending = this.queued ?? content;
        this.queued = null;
        this.handlers.onStatus('error', error instanceof Error ? error.message : String(error));
      }
      this.inFlight = false;
      return;
    }
    this.inFlight = false;
    if (this.queued !== null) {
      this.pending = this.queued;
      this.queued = null;
      await this.flush();
    }
  }

  get isDirty(): boolean {
    return this.pending !== null || this.queued !== null;
  }

  /** Stop scheduling. Callers flush first when the text must survive. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
