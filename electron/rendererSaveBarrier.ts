/** Main-owned request/ACK barrier. Timeout is a save failure, never authorization to quit. */
export class RendererSaveBarrier {
  private nextId = 0;
  private pending: { id: number; promise: Promise<boolean>; settle: (saved: boolean) => void } | null = null;

  constructor(private readonly send: (id: number) => void, private readonly timeoutMs = 30_000) {}

  request(): Promise<boolean> {
    if (this.pending) return this.pending.promise;
    const id = ++this.nextId;
    let resolve!: (saved: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const timer = setTimeout(() => this.acknowledge(id, false), this.timeoutMs);
    this.pending = { id, promise, settle: (saved) => { clearTimeout(timer); resolve(saved); } };
    try { this.send(id); } catch { this.acknowledge(id, false); }
    return promise;
  }

  acknowledge(id: unknown, saved: unknown): void {
    if (!this.pending || id !== this.pending.id || typeof saved !== 'boolean') return;
    const { settle } = this.pending;
    this.pending = null;
    settle(saved);
  }

  disconnected(): void {
    if (this.pending) this.acknowledge(this.pending.id, false);
  }
}
