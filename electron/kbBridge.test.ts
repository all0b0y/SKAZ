import { describe, expect, it, vi } from 'vitest';
import { encodeWavPcm16Mono } from '../frontend/src/audio/wav';
import { MATERIAL_EXTENSIONS } from '../frontend/src/api/bridge';
import { kbBridgeHandlers, saveFileName, validateDictation, validateSaveText, type KbBridgeDeps } from './kbBridge';

const clip = (seconds: number, rate = 16_000) => encodeWavPcm16Mono(new Float32Array(Math.round(seconds * rate)), rate);

function deps(over: Partial<KbBridgeDeps> = {}): KbBridgeDeps {
  return {
    handle: () => ({ port: 4321, token: 'tok' }),
    fetch: vi.fn(async () => new Response(JSON.stringify({ text: 'hello', language: 'en', provider: 'soniox' }), { status: 200 })) as unknown as typeof fetch,
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/Users/me/Documents/Chat.md' })),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/Users/me/a.pdf', '/Users/me/b.mp3', '/Users/me/run.sh', '/Users/me/gone.pdf'] })),
    writeTextFile: vi.fn(),
    fileSize: (path: string) => (path.includes('gone') ? null : 1234),
    documentsDir: '/Users/me/Documents',
    downloadsDir: '/Users/me/Downloads',
    materialExtensions: MATERIAL_EXTENSIONS,
    ...over,
  };
}

describe('Electron bridge — dictation (POST /kb/dictation)', () => {
  it('accepts a PCM16 mono clip up to 120 s and refuses anything else before it leaves main', () => {
    expect(validateDictation(clip(2), 'en')).toBeNull();
    expect(validateDictation(clip(120), undefined)).toBeNull();
    expect(validateDictation(clip(121), 'en')).toMatch(/too long/);
    expect(validateDictation(new ArrayBuffer(10), 'en')).toMatch(/empty/);
    expect(validateDictation('not audio', 'en')).toMatch(/missing/);
    const notWav = new Uint8Array(clip(1)).slice();
    notWav.set([0x58, 0x58, 0x58, 0x58], 0);
    expect(validateDictation(notWav.buffer, 'en')).toMatch(/not a WAV/);
    const stereo = new Uint8Array(clip(1)).slice();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(validateDictation(stereo.buffer, 'en')).toMatch(/mono/);
    expect(validateDictation(clip(1), '../x')).toMatch(/language/);
    expect(validateDictation(new ArrayBuffer(9 * 1024 * 1024), 'en')).toMatch(/too long/);
  });

  it('posts the clip with the run token, the language in the query, and returns only the text answer', async () => {
    const d = deps();
    const h = kbBridgeHandlers(d);
    const res = await h.dictate(clip(1), 'ru');
    expect(res).toEqual({ ok: true, status: 200, data: { text: 'hello', language: 'en', provider: 'soniox' } });
    const [url, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4321/kb/dictation?language=ru');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
  });

  it('passes the backend reason through and never calls it for a refused clip or before it is ready', async () => {
    const fetch409 = vi.fn(async () => new Response(JSON.stringify({ detail: 'Add a Soniox key to dictate.' }), { status: 409 }));
    const h = kbBridgeHandlers(deps({ fetch: fetch409 as unknown as typeof fetch }));
    expect(await h.dictate(clip(1), undefined)).toEqual({ ok: false, status: 409, detail: 'Add a Soniox key to dictate.' });
    expect(await h.dictate(clip(130), undefined)).toMatchObject({ ok: false, status: 0 });
    expect(fetch409).toHaveBeenCalledTimes(1);
    const notReady = kbBridgeHandlers(deps({ handle: () => null }));
    expect(await notReady.dictate(clip(1), undefined)).toEqual({ ok: false, status: 0, detail: 'backend not ready' });
  });
});

describe('Electron bridge — saveTextFile (chat export)', () => {
  it('suggests a bare .md name and writes only where the user chose', async () => {
    expect(saveFileName('Why log? / ../etc')).toBe('Why log? etc.md');
    expect(saveFileName('notes.txt')).toBe('notes.txt');
    expect(saveFileName('Chat.MD')).toBe('Chat.md');
    expect(saveFileName('a\u0001b')).toBeNull();
    expect(saveFileName('...')).toBeNull();
    expect(validateSaveText({ suggested_name: 'x', text: 'y'.repeat(6 * 1024 * 1024) })).toMatch(/too large/);

    const d = deps();
    const h = kbBridgeHandlers(d);
    expect(await h.saveTextFile({ suggested_name: 'Why log?.md', text: '# Chat' })).toEqual({ saved: true, path: '/Users/me/Documents/Chat.md' });
    expect(d.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '/Users/me/Documents/Why log?.md' }));
    expect(d.writeTextFile).toHaveBeenCalledWith('/Users/me/Documents/Chat.md', '# Chat');
  });

  it('cancel writes nothing; an invalid request opens no dialog', async () => {
    const d = deps({ showSaveDialog: vi.fn(async () => ({ canceled: true })) });
    const h = kbBridgeHandlers(d);
    expect(await h.saveTextFile({ suggested_name: 'a.md', text: 'x' })).toEqual({ saved: false });
    expect(d.writeTextFile).not.toHaveBeenCalled();
    expect(await h.saveTextFile({ suggested_name: '/', text: 'x' })).toEqual({ saved: false });
    expect(await h.saveTextFile(null)).toEqual({ saved: false });
    expect(d.showSaveDialog).toHaveBeenCalledTimes(1);
  });
});

describe('Electron bridge — chooseMaterialFiles', () => {
  it('returns path, name and size of chosen documents/audio/video only', async () => {
    const d = deps();
    const files = await kbBridgeHandlers(d).chooseMaterialFiles();
    expect(files).toEqual([
      { path: '/Users/me/a.pdf', name: 'a.pdf', size: 1234 },
      { path: '/Users/me/b.mp3', name: 'b.mp3', size: 1234 },
    ]);
    expect(d.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile', 'multiSelections'] }));
    const cancelled = kbBridgeHandlers(deps({ showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }));
    expect(await cancelled.chooseMaterialFiles()).toEqual([]);
  });
});

describe('Electron preload — the three new methods use their own channels', () => {
  it('exposes dictate, saveTextFile and chooseMaterialFiles over ipcRenderer.invoke', async () => {
    vi.resetModules();
    const invoke = vi.fn(async () => ({ ok: true }));
    let exposed: Record<string, (...args: unknown[]) => unknown> = {};
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_: string, api: Record<string, (...args: unknown[]) => unknown>) => { exposed = api; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
      webUtils: { getPathForFile: () => '' },
    }));
    const proc = process as unknown as { getSystemVersion?: () => string };
    const had = proc.getSystemVersion;
    proc.getSystemVersion = () => '15.0.0';
    await import('./preload');
    proc.getSystemVersion = had;
    const wav = clip(1);
    await exposed.dictate!(wav, 'en');
    await exposed.saveTextFile!({ suggested_name: 'a.md', text: 'x', extra: 'dropped' });
    await exposed.chooseMaterialFiles!();
    expect(invoke.mock.calls).toEqual([
      ['kb:dictate', wav, 'en'],
      ['app:save-text-file', { suggested_name: 'a.md', text: 'x' }],
      ['app:choose-material-files'],
    ]);
    vi.doUnmock('electron');
  });

  it('passes the window full-screen state to the page as a boolean, and unsubscribes', async () => {
    vi.resetModules();
    const handlers: Record<string, (event: unknown, ...args: unknown[]) => void> = {};
    const removeListener = vi.fn();
    let exposed: Record<string, (...args: unknown[]) => unknown> = {};
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_: string, api: Record<string, (...args: unknown[]) => unknown>) => { exposed = api; } },
      ipcRenderer: { invoke: vi.fn(), on: (ch: string, h: (event: unknown, ...args: unknown[]) => void) => { handlers[ch] = h; }, removeListener, send: vi.fn() },
      webUtils: { getPathForFile: () => '' },
    }));
    const proc = process as unknown as { getSystemVersion?: () => string };
    const had = proc.getSystemVersion;
    proc.getSystemVersion = () => '15.0.0';
    await import('./preload');
    proc.getSystemVersion = had;
    const seen: boolean[] = [];
    const off = exposed.onFullScreen!((on: boolean) => seen.push(on)) as () => void;
    handlers['app:full-screen']!({}, true);
    handlers['app:full-screen']!({}, 'yes');
    handlers['app:full-screen']!({}, false);
    expect(seen).toEqual([true, false, false]);
    off();
    expect(removeListener).toHaveBeenCalledWith('app:full-screen', handlers['app:full-screen']);
    vi.doUnmock('electron');
  });
});
