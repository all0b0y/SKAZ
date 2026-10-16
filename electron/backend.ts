import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BackendStatus } from '../frontend/src/api/bridge';
import { AppLog } from './logFile';
import { readLoginShellPath } from './shellPath';
import { app } from 'electron';

// Owns the lifecycle of the Python backend subprocess: pick a free loopback
// port, mint a per-run bearer token, spawn the process, poll GET /health until
// it answers, and tear it down on quit. No fake readiness — the app only
// reports "ready" after a real successful health check.

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 300;
const SHUTDOWN_GRACE_MS = 4_000;
/** Added to start failures in development only, where the backend runs from the repo. */
const DEV_START_HINT = 'Development build: make sure the Python backend is installed (uv sync in backend/).';

export interface BackendHandle {
  port: number;
  token: string;
}

type StatusListener = (status: BackendStatus) => void;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface BackendManagerOptions {
  repoRoot: string;
  dataDir: string;
  onStatus?: StatusListener;
}

export class BackendManager {
  private child: ChildProcess | null = null;
  private handle: BackendHandle | null = null;
  private status: BackendStatus = { phase: 'stopped' };
  private readonly repoRoot: string;
  private readonly dataDir: string;
  private readonly onStatus?: StatusListener;
  private readonly log: AppLog;
  /** The login shell's PATH, read once per app run; null if it could not be read. */
  private userPath: Promise<string | null> | null = null;
  /** Set while restart() waits for a stale process to exit. */
  private restarting = false;

  constructor(options: BackendManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.dataDir = options.dataDir;
    this.onStatus = options.onStatus;
    this.log = new AppLog(options.dataDir);
  }

  /** Exposed so IPC can read the same file this manager writes. */
  getLog(): AppLog {
    return this.log;
  }

  getStatus(): BackendStatus {
    return this.status;
  }

  getHandle(): BackendHandle | null {
    return this.handle;
  }

  private setStatus(status: BackendStatus): void {
    this.status = status.phase === 'error' && !app.isPackaged ? { ...status, hint: DEV_START_HINT } : status;
    // Lifecycle transitions are the most useful diagnostic in the log: they
    // explain a stuck splash screen without exposing any session content.
    this.log.write(
      status.phase === 'error' ? 'ERROR' : 'INFO',
      'app',
      `backend ${status.phase}${status.detail ? `: ${status.detail}` : ''}`,
    );
    this.onStatus?.(this.status);
  }

  private resolveSpawn(port: number): { command: string; args: string[] } {
    // Packaged app: the backend is a frozen binary inside the bundle's
    // Resources, because an installed .app has neither the repo nor uv.
    const bundled = path.join(process.resourcesPath ?? '', 'backend', 'skaz-backend');
    if (app.isPackaged && existsSync(bundled)) {
      return { command: bundled, args: ['--port', String(port)] };
    }
    // Development: prefer an existing backend virtualenv; fall back to `uv run`
    // per docs/API.md. Both run `python -m skaz --port N` from repo root.
    const venvPython = path.join(this.repoRoot, 'backend', '.venv', 'bin', 'python');
    if (existsSync(venvPython)) {
      return { command: venvPython, args: ['-m', 'skaz', '--port', String(port)] };
    }
    return {
      command: 'uv',
      args: ['run', '--project', 'backend', 'python', '-m', 'skaz', '--port', String(port)],
    };
  }

  private async waitForHealth(handle: BackendHandle, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = 'no response';
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('startup aborted');
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/health`, {
          headers: { Authorization: `Bearer ${handle.token}` },
          signal: AbortSignal.timeout(HEALTH_INTERVAL_MS * 2),
        });
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === 'ok') return;
          lastError = `unexpected /health body: ${JSON.stringify(body)}`;
        } else {
          lastError = `HTTP ${res.status}`;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await delay(HEALTH_INTERVAL_MS);
    }
    throw new Error(`backend did not become healthy within ${HEALTH_TIMEOUT_MS}ms (${lastError})`);
  }

  async start(): Promise<BackendHandle> {
    if (this.handle && this.status.phase === 'ready') return this.handle;
    this.setStatus({ phase: 'starting' });

    const port = await findFreePort();
    const token = randomBytes(32).toString('hex');
    const handle: BackendHandle = { port, token };

    const { command, args } = this.resolveSpawn(port);
    this.userPath ??= readLoginShellPath();
    const userPath = await this.userPath;
    this.log.write('INFO', 'app', userPath ? 'login shell PATH read' : 'login shell PATH unavailable; standard folders only');
    // In a packaged app `repoRoot` points inside app.asar, which is a virtual
    // archive rather than a real directory: spawning with it as cwd fails
    // before the child ever runs. The frozen backend resolves everything from
    // env vars, so the user's home is a safe, always-present working directory.
    const cwd = app.isPackaged ? app.getPath('home') : this.repoRoot;
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        SKAZ_TOKEN: token,
        SKAZ_DATA_DIR: this.dataDir,
        SKAZ_DOCUMENTS_DIR: app.getPath('documents'),
        // Development cannot connect the installed app's document library.
        SKAZ_DOCUMENTS_SANDBOX: app.isPackaged ? '' : (
          process.env.SKAZ_OPTIN_SMOKE_USER_DATA ? app.getPath('userData') : app.getPath('documents')
        ),
        SKAZ_SESSION_FILES_ROOT: app.isPackaged ? '' : process.env.SKAZ_SESSION_FILES_ROOT ?? '',
        // The backend exits on its own if this process dies without stopping it
        // (crash / force quit), so it never keeps the database and queue locks.
        SKAZ_PARENT_PID: String(process.pid),
        // Where the user's own tools (Codex, Node) live; see electron/shellPath.ts.
        ...(userPath ? { SKAZ_USER_PATH: userPath } : {}),
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[backend] ${d}`);
      this.log.writeBackendChunk(d.toString('utf8'), 'stdout');
    });
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[backend] ${d}`);
      this.log.writeBackendChunk(d.toString('utf8'), 'stderr');
    });

    const abort = new AbortController();
    let exited = false;
    child.on('exit', (code, signalName) => {
      exited = true;
      abort.abort();
      // A process that restart() already replaced must not report over its successor.
      if (this.child !== child) return;
      this.child = null;
      if (this.status.phase !== 'stopped') {
        this.setStatus({
          phase: 'error',
          detail: `backend exited (code ${code ?? 'null'}, signal ${signalName ?? 'none'})`,
        });
      }
    });
    child.on('error', (err) => {
      exited = true;
      abort.abort();
      if (this.child !== child) return;
      this.setStatus({
        phase: 'error',
        detail:
          command === 'uv'
            ? `failed to launch backend via uv: ${err.message}. Is uv installed and backend/ present?`
            : `failed to launch backend: ${err.message}`,
      });
    });

    try {
      await this.waitForHealth(handle, abort.signal);
    } catch (err) {
      if (!exited) this.setStatus({ phase: 'error', detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    this.handle = handle;
    this.setStatus({ phase: 'ready', detail: `127.0.0.1:${port}` });
    return handle;
  }

  /**
   * Start again after a failed start (the startup screen's Try again). Resolves
   * false when the last start did not fail; progress arrives as status events.
   */
  async restart(): Promise<boolean> {
    if (this.status.phase !== 'error' || this.restarting) return false;
    this.restarting = true;
    try {
      // A start that timed out can leave its process running; it must release its locks first.
      const stale = this.child;
      this.child = null;
      this.handle = null;
      await this.terminate(stale);
    } finally {
      this.restarting = false;
    }
    // The app may have started quitting while the stale process was exiting.
    if (this.getStatus().phase === 'stopped') return false;
    void this.start().catch(() => undefined);
    return true;
  }

  async stop(): Promise<void> {
    this.setStatus({ phase: 'stopped' });
    const child = this.child;
    this.child = null;
    this.handle = null;
    await this.terminate(child);
  }

  private terminate(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
