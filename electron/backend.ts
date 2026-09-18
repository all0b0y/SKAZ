import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BackendStatus } from '../frontend/src/api/bridge';
import { AppLog } from './logFile';
import { app } from 'electron';

// Owns the lifecycle of the Python backend subprocess: pick a free loopback
// port, mint a per-run bearer token, spawn the process, poll GET /health until
// it answers, and tear it down on quit. No fake readiness — the app only
// reports "ready" after a real successful health check.

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 300;
const SHUTDOWN_GRACE_MS = 4_000;

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
    this.status = status;
    // Lifecycle transitions are the most useful diagnostic in the log: they
    // explain a stuck splash screen without exposing any session content.
    this.log.write(
      status.phase === 'error' ? 'ERROR' : 'INFO',
      'app',
      `backend ${status.phase}${status.detail ? `: ${status.detail}` : ''}`,
    );
    this.onStatus?.(status);
  }

  private resolveSpawn(port: number): { command: string; args: string[] } {
    // Prefer an existing backend virtualenv; fall back to `uv run` per
    // docs/API.md. Both run `python -m audiohelper --port N` from repo root.
    const venvPython = path.join(this.repoRoot, 'backend', '.venv', 'bin', 'python');
    if (existsSync(venvPython)) {
      return { command: venvPython, args: ['-m', 'audiohelper', '--port', String(port)] };
    }
    return {
      command: 'uv',
      args: ['run', '--project', 'backend', 'python', '-m', 'audiohelper', '--port', String(port)],
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
    const child = spawn(command, args, {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        AUDIOHELPER_TOKEN: token,
        AUDIOHELPER_DATA_DIR: this.dataDir,
        AUDIOHELPER_DOCUMENTS_DIR: app.getPath('documents'),
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

  async stop(): Promise<void> {
    this.setStatus({ phase: 'stopped' });
    const child = this.child;
    this.child = null;
    this.handle = null;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
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
