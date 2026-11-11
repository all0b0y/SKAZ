// 0.4.0 W4 (B6 report, R0 risk): while a background job of the backend runs — a weekly check, Check links,
// an Explore run or a research task — macOS must not suspend SKAZ (App Nap / sleep would stall it with the
// window hidden in the tray), and the tray says what is running. The main process asks the backend itself:
// the renderer is throttled when hidden, so it can't be the one that keeps the app awake.
//
// The tray line is the job KIND in SKAZ's own words, never the job title: a research task's title is the
// user's own text and the tray is visible with the window closed (trayStatus.ts).

export const POLL_MS = 15_000;
export const TRAY_SOURCE = 'background-jobs';

export interface JobSummary {
  owner: string;
  state: string;
  stage: string;
  updated_at: string;
}

export interface BackgroundJobsDeps {
  /** GET a backend route with this run's token; null when the backend isn't there or answered an error. */
  getJson: (route: string) => Promise<unknown>;
  /** Electron's powerSaveBlocker, narrowed. */
  blocker: { start: () => number; stop: (id: number) => void };
  tray: { set: (source: string, text: string | null) => void };
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const KIND: Record<string, string> = {
  weekly: 'Weekly check',
  links: 'Checking links',
  repeats: 'Checking repeats',
  explore: 'Exploring',
  research: 'Research task',
};

const STAGE: Record<string, string> = {
  collect: 'collecting',
  rules: 'filtering',
  decision: 'sorting',
  novelty: 'checking novelty',
  ready: 'finishing',
};

/** The tray line for the running jobs (the most recently updated one), or null when none runs. */
export function trayLine(jobs: readonly JobSummary[]): string | null {
  const running = jobs.filter((job) => job.state === 'running');
  if (running.length === 0) return null;
  const latest = [...running].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!;
  const kind = KIND[latest.owner] ?? 'Working in the background';
  const stage = STAGE[latest.stage];
  const more = running.length > 1 ? ` · +${running.length - 1} more` : '';
  return `${kind}${stage ? ` · ${stage}` : ''}${more}`;
}

function parseJobs(data: unknown): JobSummary[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const jobs = (data as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return null;
  return jobs.filter((job): job is JobSummary =>
    typeof job === 'object' && job !== null
    && typeof (job as JobSummary).owner === 'string'
    && typeof (job as JobSummary).state === 'string'
    && typeof (job as JobSummary).stage === 'string'
    && typeof (job as JobSummary).updated_at === 'string');
}

export class BackgroundJobs {
  private blockId: number | null = null;
  private timer: unknown = null;
  private polling = false;

  constructor(private readonly deps: BackgroundJobsDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.setInterval(() => { void this.poll(); }, POLL_MS);
    void this.poll();
  }

  /** Quit: let the Mac sleep again and clear the tray line. */
  stop(): void {
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
    this.apply(null);
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const jobs = parseJobs(await this.deps.getJson('/kb/explore/jobs'));
      // No answer (backend starting, restarting or gone, no library): nothing is known to run, so nothing
      // holds the Mac awake — never a blocker left on after the backend went away.
      this.apply(jobs === null ? null : trayLine(jobs));
    } finally {
      this.polling = false;
    }
  }

  get holdingAwake(): boolean {
    return this.blockId !== null;
  }

  private apply(line: string | null): void {
    this.deps.tray.set(TRAY_SOURCE, line);
    if (line !== null && this.blockId === null) {
      this.blockId = this.deps.blocker.start();
    } else if (line === null && this.blockId !== null) {
      this.deps.blocker.stop(this.blockId);
      this.blockId = null;
    }
  }
}
