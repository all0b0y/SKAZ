export interface ContextualNotifierState {
  inFlight: number | null;
  pending: number | null;
  error: string | null;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One renderer-side latest-watermark notification; backend owns actual windows. */
export class ContextualSchedulerNotifier {
  private inFlight: number | null = null;
  private pending: number | null = null;
  private error: string | null = null;
  private running = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly advance: (throughSequence: number) => Promise<unknown>) {}

  snapshot(): ContextualNotifierState {
    return { inFlight: this.inFlight, pending: this.pending, error: this.error };
  }

  notify(sequence: number): void {
    this.pending = Math.max(this.pending ?? sequence, sequence);
    if (!this.error) void this.run();
  }

  retry(sequence?: number): void {
    if (sequence !== undefined) {
      this.pending = Math.max(this.pending ?? sequence, sequence);
    }
    if (this.pending === null) return;
    this.error = null;
    void this.run();
  }

  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private async run(): Promise<void> {
    if (this.running || this.pending === null || this.error) return;
    this.running = true;
    while (this.pending !== null && !this.error) {
      const sequence = this.pending;
      this.pending = null;
      this.inFlight = sequence;
      try {
        await this.advance(sequence);
      } catch (error) {
        this.error = message(error);
        this.pending = Math.max(this.pending ?? sequence, sequence);
      } finally {
        this.inFlight = null;
      }
    }
    this.running = false;
    this.settle();
  }
}
