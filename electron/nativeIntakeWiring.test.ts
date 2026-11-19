import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATERIAL_EXTENSIONS } from '../frontend/src/api/bridge';
import { CHANNELS } from './channels';
import { kbBridgeHandlers, type KbBridgeDeps } from './kbBridge';
import { FILE_CHANGED_MESSAGE } from './nativeIntake041';
import { hashBoundedDiskFile } from './nativeIntake041/diskFingerprint';

const FIXTURES_DIR = resolve(__dirname, 'nativeIntake041', 'fixtures');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skaz-v1-wiring-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function diskDeps(over: Partial<KbBridgeDeps> = {}): KbBridgeDeps {
  return {
    handle: () => ({ port: 5432, token: 'test-token' }),
    fetch: vi.fn(async () => new Response(JSON.stringify({ material: { id: 'mat-1' }, already_in_library: false }), { status: 201 })) as unknown as typeof fetch,
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    writeTextFile: vi.fn(),
    fileSize: (p) => {
      try {
        const st = statSync(p);
        return st.isFile() ? st.size : null;
      } catch {
        return null;
      }
    },
    realPath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    },
    readHeader: (p, maxBytes) => {
      let fd: number | null = null;
      try {
        fd = openSync(p, 'r');
        const buf = new Uint8Array(maxBytes);
        const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead);
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
    readBoundedFile: (p, maxBytes) => {
      let fd: number | null = null;
      try {
        fd = openSync(p, 'r');
        const st = fstatSync(fd);
        if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
        const buf = new Uint8Array(st.size);
        let offset = 0;
        while (offset < st.size) {
          const read = readSync(fd, buf, offset, st.size - offset, offset);
          if (read <= 0) break;
          offset += read;
        }
        return offset === st.size ? buf : buf.subarray(0, offset);
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
    hashBoundedFile: hashBoundedDiskFile,
    documentsDir: '/tmp',
    downloadsDir: '/tmp',
    materialExtensions: MATERIAL_EXTENSIONS,
    ...over,
  };
}

describe('V1 production bridge wiring — kbBridgeHandlers', () => {
  it('picks real DOCX and image fixtures (incl. HEIC), preserves selection identity, and handles cancellation', async () => {
    const picked = [
      join(FIXTURES_DIR, 'sample-note.docx'),
      join(FIXTURES_DIR, 'sample-chart.jpg'),
      join(FIXTURES_DIR, 'sample-chart.png'),
      join(FIXTURES_DIR, 'sample-chart.webp'),
      join(FIXTURES_DIR, 'sample-chart.heic'),
    ];
    let seq = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/kb/materials/image-preview')) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return new Response(JSON.stringify({ material: { id: 'mat-new', status: 'ready' }, already_in_library: false }), {
        status: 201,
      });
    });

    const bridge = kbBridgeHandlers(
      diskDeps({
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: picked })),
        fetch: fetchMock as unknown as typeof fetch,
        newId: () => `sel-${++seq}`,
      }),
    );

    const batch = await bridge.chooseMaterialBatch();
    expect(batch.rejected).toEqual([]);
    expect(batch.accepted.map((a) => [a.selectionId, a.name, a.formatId, a.nativePreviewable])).toEqual([
      ['sel-1', 'sample-note.docx', 'docx', false],
      ['sel-2', 'sample-chart.jpg', 'jpeg', true],
      ['sel-3', 'sample-chart.png', 'png', true],
      ['sel-4', 'sample-chart.webp', 'webp', true],
      ['sel-5', 'sample-chart.heic', 'heic', false],
    ]);

    // Import admitted DOCX into folder 'fld-1' with explicit toWiki=false
    const docxPath = join(FIXTURES_DIR, 'sample-note.docx');
    const docxSha = createHash('sha256').update(readFileSync(docxPath)).digest('hex');
    const docxImport = await bridge.importSelection({ selectionId: 'sel-1', folderId: 'fld-1', toWiki: false });
    expect(docxImport).toMatchObject({ ok: true, status: 201 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:5432/kb/materials/file',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: JSON.stringify({
          path: realpathSync(docxPath),
          folder_id: 'fld-1',
          title: null,
          to_wiki: false,
          selection_source: 'picker',
          expected_size: statSync(docxPath).size,
          expected_sha256: docxSha,
        }),
      }),
    );

    // Import admitted HEIC forces to_wiki: false even if caller passes true
    const heicPath = join(FIXTURES_DIR, 'sample-chart.heic');
    const heicSha = createHash('sha256').update(readFileSync(heicPath)).digest('hex');
    const heicImport = await bridge.importSelection({ selectionId: 'sel-5', folderId: 'fld-1', toWiki: true });
    expect(heicImport).toMatchObject({ ok: true, status: 201 });
    const heicCallBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(heicCallBody.to_wiki).toBe(false);
    expect(heicCallBody.selection_source).toBe('picker');
    expect(heicCallBody.expected_size).toBe(statSync(heicPath).size);
    expect(heicCallBody.expected_sha256).toBe(heicSha);

    // Preview authorized HEIC selection hits /kb/materials/image-preview with expected_size and expected_sha256
    const preview = await bridge.imagePreview('sel-5');
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.mimeType).toBe('image/png');
      expect(Array.from(preview.data.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:5432/kb/materials/image-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          path: realpathSync(heicPath),
          expected_size: statSync(heicPath).size,
          expected_sha256: heicSha,
        }),
      }),
    );

    // Preview non-image selection (DOCX) is refused without calling backend
    const callsBeforeRefusal = fetchMock.mock.calls.length;
    expect(await bridge.imagePreview('sel-1')).toMatchObject({ ok: false, status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRefusal);

    // Fabricated / unknown selectionId is refused before any backend call
    expect(await bridge.importSelection({ selectionId: '/etc/passwd', folderId: 'fld-1' })).toMatchObject({ ok: false, status: 403 });
    expect(await bridge.imagePreview('/etc/passwd')).toMatchObject({ ok: false, status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRefusal);

    // Cancellation returns empty batch without throwing
    const cancelled = kbBridgeHandlers(diskDeps({ showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) }));
    expect(await cancelled.chooseMaterialBatch()).toEqual({ accepted: [], rejected: [] });
    expect(await cancelled.chooseMaterialFiles()).toEqual([]);
  });

  it('refuses preview and import after a same-length disk edit and succeeds only on deliberate fresh selection', async () => {
    const dir = makeTempDir();
    const tempDocx = join(dir, 'notes.docx');
    const tempHeic = join(dir, 'photo.heic');
    const docxOriginal = Buffer.from(readFileSync(join(FIXTURES_DIR, 'sample-note.docx')));
    const heicOriginal = Buffer.from(readFileSync(join(FIXTURES_DIR, 'sample-chart.heic')));
    writeFileSync(tempDocx, docxOriginal);
    writeFileSync(tempHeic, heicOriginal);

    let seq = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/kb/materials/image-preview')) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return new Response(JSON.stringify({ material: { id: 'mat-fresh', status: 'ready' }, already_in_library: false }), {
        status: 201,
      });
    });

    const bridge = kbBridgeHandlers(
      diskDeps({
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [tempDocx, tempHeic] })),
        fetch: fetchMock as unknown as typeof fetch,
        newId: () => `tok-${++seq}`,
      }),
    );

    const first = await bridge.chooseMaterialBatch();
    expect(first.accepted.map((a) => a.selectionId)).toEqual(['tok-1', 'tok-2']);

    // Edit both files with the exact same byte length
    const docxEdited = Buffer.from(docxOriginal);
    docxEdited[docxEdited.length - 1] = (docxEdited[docxEdited.length - 1] ?? 0) ^ 0x01;
    writeFileSync(tempDocx, docxEdited);
    const heicEdited = Buffer.from(heicOriginal);
    heicEdited[heicEdited.length - 1] = (heicEdited[heicEdited.length - 1] ?? 0) ^ 0x01;
    writeFileSync(tempHeic, heicEdited);

    // Neither preview nor import hits backend for changed files, and old tokens never refresh
    expect(await bridge.imagePreview('tok-2')).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(await bridge.importSelection({ selectionId: 'tok-1', folderId: 'inbox', toWiki: false })).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(await bridge.importSelection({ selectionId: 'tok-2', folderId: 'inbox', toWiki: false })).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // Retrying old token still fails
    expect(await bridge.importSelection({ selectionId: 'tok-1', folderId: 'inbox', toWiki: false })).toMatchObject({
      ok: false,
      status: 422,
      code: 'file_changed',
    });

    // Deliberate fresh selection creates new tokens pinned to the edited versions
    const second = await bridge.chooseMaterialBatch();
    expect(second.accepted.map((a) => a.selectionId)).toEqual(['tok-3', 'tok-4']);
    expect(await bridge.imagePreview('tok-4')).toMatchObject({ ok: true, status: 200 });
    expect(await bridge.importSelection({ selectionId: 'tok-3', folderId: 'inbox', toWiki: false })).toMatchObject({
      ok: true,
      status: 201,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Old tokens remain invalid
    expect(await bridge.imagePreview('tok-2')).toMatchObject({ ok: false, status: 422, code: 'file_changed' });
  });

  it('validates dropped paths, isolates skazDataDir, and imports validated clipboard images', async () => {
    const dir = makeTempDir();
    const skazDataDir = join(dir, 'data');
    mkdirSync(skazDataDir, { recursive: true });
    const insideData = join(skazDataDir, 'internal.png');
    const badHeic = join(dir, 'corrupt.heic');
    const pngBytes = readFileSync(join(FIXTURES_DIR, 'sample-chart.png'));
    writeFileSync(insideData, pngBytes);
    writeFileSync(badHeic, 'not a heic');

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ material: { id: 'mat-clip' } }), { status: 201 }));
    let seq = 0;
    const bridge = kbBridgeHandlers(
      diskDeps({
        skazDataDir,
        fetch: fetchMock as unknown as typeof fetch,
        newId: () => `id-${++seq}`,
      }),
    );

    const dropBatch = await bridge.droppedMaterialFiles([
      join(FIXTURES_DIR, 'sample-chart.heic'),
      insideData,
      badHeic,
    ]);
    expect(dropBatch.accepted.map((a) => a.name)).toEqual(['sample-chart.heic']);
    expect(dropBatch.rejected).toEqual([
      { name: 'internal.png', reason: "Files from SKAZ's own data folder can't be added.", source: 'drop' },
      { name: 'corrupt.heic', reason: "This file doesn't match a valid HEIC image.", source: 'drop' },
    ]);

    const ab = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);
    const clip = bridge.validateClipboardImage({ bytes: ab, mimeType: 'image/png', suggestedName: 'Diagram' });
    expect(clip.ok).toBe(true);
    if (!clip.ok) throw new Error('expected ok');

    const preview = await bridge.imagePreview(clip.selection.selectionId);
    expect(preview).toMatchObject({ ok: true, status: 200, data: { mimeType: 'image/png' } });

    const imported = await bridge.importSelection({ selectionId: clip.selection.selectionId, folderId: 'inbox' });
    expect(imported).toMatchObject({ ok: true, status: 201 });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5432/kb/materials/clipboard-image?folder_id=inbox&file_name=Diagram.png');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('exposes window.skaz.nativeIntake in preload and registers trusted-sender IPC handlers', async () => {
    vi.resetModules();
    const invoke = vi.fn(async () => ({ accepted: [], rejected: [] }));
    let exposed: Record<string, unknown> = {};
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_: string, api: Record<string, unknown>) => { exposed = api; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
      webUtils: { getPathForFile: (file: { name?: string }) => (file.name === 'chart.heic' ? '/Users/me/Downloads/chart.heic' : '') },
    }));
    const proc = process as unknown as { getSystemVersion?: () => string };
    const had = proc.getSystemVersion;
    proc.getSystemVersion = () => '15.0.0';
    await import('./preload');
    proc.getSystemVersion = had;

    const nativeIntake = exposed.nativeIntake as {
      chooseMaterialFiles: () => Promise<unknown>;
      droppedMaterialFiles: (files: File[]) => Promise<unknown>;
      validateClipboardImage: (input: { bytes: ArrayBuffer; mimeType: string; suggestedName?: string }) => Promise<unknown>;
      importSelection: (req: { selectionId: string; folderId: string }) => Promise<unknown>;
      imagePreview: (id: string) => Promise<unknown>;
    };
    expect(nativeIntake).toBeDefined();

    await nativeIntake.chooseMaterialFiles();
    await nativeIntake.droppedMaterialFiles([
      { name: 'chart.heic' } as unknown as File,
      { name: 'spoof.png' } as unknown as File,
    ]);
    const ab = new ArrayBuffer(8);
    await nativeIntake.validateClipboardImage({ bytes: ab, mimeType: 'image/png', suggestedName: 'Clip' });
    await nativeIntake.importSelection({ selectionId: 'sel-1', folderId: 'inbox' });
    await nativeIntake.imagePreview('sel-1');

    expect(invoke.mock.calls).toEqual([
      [CHANNELS.chooseMaterialBatch],
      [CHANNELS.droppedMaterialFiles, ['/Users/me/Downloads/chart.heic']],
      [CHANNELS.validateClipboardImage, { bytes: ab, mimeType: 'image/png', suggestedName: 'Clip' }],
      [CHANNELS.importMaterialSelection, {
        selectionId: 'sel-1',
        folderId: 'inbox',
        title: null,
        toWiki: null,
        language: null,
        translate: false,
      }],
      [CHANNELS.materialImagePreview, 'sel-1'],
    ]);

    // Verify ipc.ts registers all new channels and rejects untrusted senders
    vi.resetModules();
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    vi.doMock('electron', () => ({
      app: { getPath: () => '/tmp' },
      BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      ipcMain: { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => registered.set(ch, fn) },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
    }));
    const { registerIpc } = await import('./ipc');
    registerIpc(
      { getHandle: () => null, getStatus: () => ({ phase: 'stopped' }), getLog: () => ({ directory: '/tmp' }), getDataDir: () => '/tmp/data', restart: () => false } as never,
      () => 1,
    );
    const untrusted = { sender: { id: 999 }, senderFrame: { parent: null } };
    expect(await registered.get(CHANNELS.chooseMaterialBatch)!(untrusted)).toEqual({ accepted: [], rejected: [] });
    expect(await registered.get(CHANNELS.droppedMaterialFiles)!(untrusted, ['/etc/passwd'])).toEqual({ accepted: [], rejected: [] });
    expect(await registered.get(CHANNELS.validateClipboardImage)!(untrusted, {})).toEqual({ ok: false, reason: 'untrusted sender' });
    expect(await registered.get(CHANNELS.importMaterialSelection)!(untrusted, { selectionId: 'sel-1', folderId: 'inbox' })).toEqual({ ok: false, status: 0, detail: 'untrusted sender' });
    expect(await registered.get(CHANNELS.materialImagePreview)!(untrusted, 'sel-1')).toEqual({ ok: false, status: 0, detail: 'untrusted sender' });

    vi.doUnmock('electron');
  });

  it('keeps kbBridgeHandlers responsive during async multi-chunk revalidation and preserves blocked-file reselection', async () => {
    const dir = makeTempDir();
    const docPath = join(dir, 'large-note.docx');
    const docBytes = readFileSync(join(FIXTURES_DIR, 'sample-note.docx'));
    writeFileSync(docPath, docBytes);

    let gate: { promise: Promise<void>; resolve: () => void } | null = null;
    const pausedStarted = { resolve: () => {} };
    let pauseNextHash = false;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ material: { id: 'mat-ok' }, already_in_library: false }), { status: 201 }));
    let seq = 0;

    const bridge = kbBridgeHandlers(
      diskDeps({
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [docPath] })),
        fetch: fetchMock as unknown as typeof fetch,
        newId: () => `resp-${++seq}`,
        hashBoundedFile: async (path, maxBytes) => {
          if (pauseNextHash) {
            let resolve!: () => void;
            const promise = new Promise<void>((res) => {
              resolve = res;
            });
            gate = { promise, resolve };
            pausedStarted.resolve();
            await promise;
          }
          return hashBoundedDiskFile(path, maxBytes, { chunkBytes: 256 });
        },
      }),
    );

    const picked = await bridge.chooseMaterialBatch();
    expect(picked.accepted).toHaveLength(1);
    const staleId = picked.accepted[0]!.selectionId;

    // Modify the file with an identical byte length before import
    const edited = Buffer.from(docBytes);
    edited[edited.length - 1] = (edited[edited.length - 1] ?? 0) ^ 0x01;
    writeFileSync(docPath, edited);

    pauseNextHash = true;
    const started = new Promise<void>((res) => {
      pausedStarted.resolve = res;
    });

    const events: string[] = [];
    let importDone = false;
    const importPromise = bridge.importSelection({ selectionId: staleId, folderId: 'inbox', toWiki: false }).then((res) => {
      importDone = true;
      events.push('import-done');
      return res;
    });

    await started;
    expect(importDone).toBe(false);

    // Unrelated bridge work and timer callbacks complete before the deferred multi-chunk revalidation finishes
    const pngBytes = readFileSync(join(FIXTURES_DIR, 'sample-chart.png'));
    const clip = bridge.validateClipboardImage({
      bytes: pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
      mimeType: 'image/png',
    });
    expect(clip.ok).toBe(true);
    events.push('clipboard-validated');
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('unrelated-timer');
        resolve();
      }, 0);
    });
    expect(importDone).toBe(false);

    gate!.resolve();
    const refused = await importPromise;
    expect(refused).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toEqual(['clipboard-validated', 'unrelated-timer', 'import-done']);

    // Deliberate reselection admits a new token and succeeds
    pauseNextHash = false;
    const fresh = await bridge.chooseMaterialBatch();
    expect(fresh.accepted).toHaveLength(1);
    expect(fresh.accepted[0]!.selectionId).not.toBe(staleId);
    const imported = await bridge.importSelection({ selectionId: fresh.accepted[0]!.selectionId, folderId: 'inbox', toWiki: false });
    expect(imported).toMatchObject({ ok: true, status: 201 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
