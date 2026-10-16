import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}
const children: FakeChild[] = [];
const spawnEnvs: Array<Record<string, string | undefined>> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = vi.fn((_command: string, _args: string[], options: { env?: Record<string, string | undefined> }) => {
    spawnEnvs.push(options.env ?? {});
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { ...actual, default: { ...actual, spawn }, spawn };
});
vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '9.8.7', getPath: (name: string) => `/tmp/skaz-restart-test/${name}` } }));
vi.mock('./shellPath', () => ({ readLoginShellPath: async () => null }));
vi.mock('./logFile', () => ({
  AppLog: class {
    directory = '/tmp/skaz-restart-test/logs';
    write(): void {}
    writeBackendChunk(): void {}
    read(): string { return ''; }
  },
}));

afterEach(() => {
  children.length = 0;
  vi.unstubAllGlobals();
});

describe('BackendManager.restart', () => {
  it('retries a failed start, and a replaced process exiting late cannot flip it back to an error', async () => {
    const { BackendManager } = await import('./backend');
    const health = vi.fn(async (): Promise<unknown> => { throw new Error('connection refused'); });
    vi.stubGlobal('fetch', health);
    const manager = new BackendManager({ repoRoot: '/repo', dataDir: '/tmp/skaz-restart-test' });
    expect(await manager.restart()).toBe(false);

    const first = manager.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    // Settings → About reads the app's own version from here (QA A21).
    expect(spawnEnvs.at(-1)!.SKAZ_APP_VERSION).toBe('9.8.7');
    children[0]!.emit('exit', 1, null);
    await first;
    expect(manager.getStatus().phase).toBe('error');
    expect(manager.getStatus().hint).toMatch(/uv sync/);

    health.mockImplementation(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));
    expect(await manager.restart()).toBe(true);
    await vi.waitFor(() => expect(manager.getStatus().phase).toBe('ready'), { timeout: 3_000 });
    expect(manager.getStatus().hint).toBeUndefined();
    expect(children).toHaveLength(2);

    children[0]!.emit('exit', null, 'SIGTERM');
    expect(manager.getStatus().phase).toBe('ready');
    expect(await manager.restart()).toBe(false);
  });
});
