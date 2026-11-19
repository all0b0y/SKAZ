import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashBoundedDiskFile, type BoundedDiskHandle } from './diskFingerprint';
import {
  ADMIT_CONCURRENCY,
  classifyMaterialExtension,
  createPreloadIntakeBoundary,
  FILE_CHANGED_MESSAGE,
  MAX_DOCX_BYTES,
  MAX_IMAGE_BYTES,
  nativeIntakeHandlers,
  sniffImageHeader,
  type BoundedFileFingerprint,
  type NativeIntakeDeps,
} from './index';

const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skaz-native-intake041-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function realDiskDeps(over: Partial<NativeIntakeDeps> = {}): NativeIntakeDeps {
  return {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    realPath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return null;
      }
    },
    statFile: (p) => {
      try {
        const st = statSync(p);
        return { isFile: st.isFile(), size: st.size };
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
      try {
        const st = statSync(p);
        if (!st.isFile() || st.size > maxBytes) return null;
        return new Uint8Array(readFileSync(p));
      } catch {
        return null;
      }
    },
    hashBoundedFile: hashBoundedDiskFile,
    downloadsDir: '/tmp',
    ...over,
  };
}

describe('nativeIntake041 — format classification & header sniffing', () => {
  it('classifies new 0.4.1 formats (docx, jpg/jpeg, png, webp, heic) and preserves existing formats', () => {
    expect(classifyMaterialExtension('/Users/me/lecture-notes.docx')).toMatchObject({
      ext: 'docx',
      category: 'docx',
      route: 'document',
      isNew041: true,
      nativePreviewable: false,
      maxBytes: MAX_DOCX_BYTES,
    });
    expect(classifyMaterialExtension('/Users/me/photo.HEIC')).toMatchObject({
      ext: 'heic',
      category: 'image',
      route: 'image',
      formatId: 'heic',
      mimeType: 'image/heic',
      isNew041: true,
      nativePreviewable: false,
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(classifyMaterialExtension('/Users/me/photo.jpeg')).toMatchObject({
      ext: 'jpeg',
      category: 'image',
      formatId: 'jpeg',
      nativePreviewable: true,
    });
    expect(classifyMaterialExtension('/Users/me/photo.png')?.formatId).toBe('png');
    expect(classifyMaterialExtension('/Users/me/photo.webp')?.formatId).toBe('webp');
    expect(classifyMaterialExtension('/Users/me/paper.pdf')).toMatchObject({
      category: 'pdf',
      route: 'document',
      isNew041: false,
    });
    expect(classifyMaterialExtension('/Users/me/notes.markdown')?.category).toBe('text');
    expect(classifyMaterialExtension('/Users/me/talk.m4a')?.route).toBe('speech');
    expect(classifyMaterialExtension('/Users/me/folder.pdf/noext')).toBeNull();
    expect(classifyMaterialExtension('/Users/me/script.sh')).toBeNull();
  });

  it('sniffs real disk-backed image fixtures including HEIC', () => {
    expect(sniffImageHeader(readFileSync(join(FIXTURES_DIR, 'sample-chart.jpg')).subarray(0, 64))).toBe('jpeg');
    expect(sniffImageHeader(readFileSync(join(FIXTURES_DIR, 'sample-chart.png')).subarray(0, 64))).toBe('png');
    expect(sniffImageHeader(readFileSync(join(FIXTURES_DIR, 'sample-chart.webp')).subarray(0, 64))).toBe('webp');
    expect(sniffImageHeader(readFileSync(join(FIXTURES_DIR, 'sample-chart.heic')).subarray(0, 64))).toBe('heic');
    // MP4 ftyp isom without HEIF brand must NOT sniff as heic
    const mp4Head = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffImageHeader(mp4Head)).toBeNull();
  });
});

describe('nativeIntake041 — trusted disk selection & path scoping', () => {
  it('accepts real disk-backed DOCX and image fixtures via the native picker and issues scoped selectionIds', async () => {
    const picked = [
      join(FIXTURES_DIR, 'sample-note.docx'),
      join(FIXTURES_DIR, 'sample-chart.jpg'),
      join(FIXTURES_DIR, 'sample-chart.png'),
      join(FIXTURES_DIR, 'sample-chart.webp'),
      join(FIXTURES_DIR, 'sample-chart.heic'),
    ];
    let seq = 0;
    const handlers = nativeIntakeHandlers(
      realDiskDeps({
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: picked })),
        newId: () => `sel-${++seq}`,
      }),
    );

    const batch = await handlers.chooseMaterialFiles();
    expect(batch.rejected).toEqual([]);
    expect(batch.accepted.map((item) => [item.selectionId, item.name, item.formatId, item.nativePreviewable])).toEqual([
      ['sel-1', 'sample-note.docx', 'docx', false],
      ['sel-2', 'sample-chart.jpg', 'jpeg', true],
      ['sel-3', 'sample-chart.png', 'png', true],
      ['sel-4', 'sample-chart.webp', 'webp', true],
      ['sel-5', 'sample-chart.heic', 'heic', false],
    ]);

    // Only explicitly admitted selectionIds resolve; arbitrary paths or unknown IDs never resolve
    expect(handlers.resolveTrustedPath('sel-5')).toBe(realpathSync(join(FIXTURES_DIR, 'sample-chart.heic')));
    expect(handlers.resolveTrustedPath('/etc/passwd')).toBeNull();
    expect(handlers.resolveTrustedPath('sel-unknown')).toBeNull();

    // Bounded preview reads work only for admitted image selections
    const heicBytes = await handlers.readBoundedPreviewBytes('sel-5');
    expect(heicBytes?.byteLength).toBeGreaterThan(100);
    expect(await handlers.readBoundedPreviewBytes('sel-1')).toBeNull(); // docx is not an image
    expect(await handlers.readBoundedPreviewBytes('/etc/passwd')).toBeNull();

    // DOCX and images pin sha256 to exact file bytes
    for (const [idx, filePath] of picked.entries()) {
      const expectedSha = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      expect(batch.accepted[idx]!.sha256).toBe(expectedSha);
      expect((await handlers.verifySelectionVersion(batch.accepted[idx]!.selectionId)).ok).toBe(true);
    }
  });

  it('rejects same-length and size-changing edits after selection without refreshing the old token', async () => {
    const dir = makeTempDir();
    const tempDocx = join(dir, 'draft.docx');
    const tempPng = join(dir, 'diagram.png');
    const docxOriginal = Buffer.from(readFileSync(join(FIXTURES_DIR, 'sample-note.docx')));
    const pngOriginal = Buffer.from(readFileSync(join(FIXTURES_DIR, 'sample-chart.png')));
    writeFileSync(tempDocx, docxOriginal);
    writeFileSync(tempPng, pngOriginal);

    let seq = 0;
    const handlers = nativeIntakeHandlers(
      realDiskDeps({
        showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [tempDocx, tempPng] })),
        newId: () => `ver-${++seq}`,
      }),
    );

    const first = await handlers.chooseMaterialFiles();
    expect(first.rejected).toEqual([]);
    const [docxSel, pngSel] = first.accepted;
    expect(docxSel?.sha256).toBe(createHash('sha256').update(docxOriginal).digest('hex'));
    expect(pngSel?.sha256).toBe(createHash('sha256').update(pngOriginal).digest('hex'));

    // Same-length edits (size identical, last byte modified)
    const docxEdited = Buffer.from(docxOriginal);
    docxEdited[docxEdited.length - 1] = (docxEdited[docxEdited.length - 1] ?? 0) ^ 0x01;
    expect(docxEdited.length).toBe(docxOriginal.length);
    writeFileSync(tempDocx, docxEdited);

    const pngEdited = Buffer.from(pngOriginal);
    pngEdited[pngEdited.length - 1] = (pngEdited[pngEdited.length - 1] ?? 0) ^ 0x01;
    expect(pngEdited.length).toBe(pngOriginal.length);
    writeFileSync(tempPng, pngEdited);

    // Old tokens fail and are never silently refreshed
    expect(await handlers.verifySelectionVersion(docxSel!.selectionId)).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(await handlers.verifySelectionVersion(pngSel!.selectionId)).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(await handlers.readBoundedPreviewBytes(pngSel!.selectionId)).toBeNull();
    expect((await handlers.verifySelectionVersion(docxSel!.selectionId)).ok).toBe(false);

    // Deliberate fresh selection issues new tokens bound to the edited versions
    const second = await handlers.chooseMaterialFiles();
    expect(second.rejected).toEqual([]);
    const [freshDocx, freshPng] = second.accepted;
    expect(freshDocx!.selectionId).not.toBe(docxSel!.selectionId);
    expect(freshPng!.selectionId).not.toBe(pngSel!.selectionId);
    expect(freshDocx!.sha256).toBe(createHash('sha256').update(docxEdited).digest('hex'));
    expect(freshPng!.sha256).toBe(createHash('sha256').update(pngEdited).digest('hex'));
    expect((await handlers.verifySelectionVersion(freshDocx!.selectionId)).ok).toBe(true);
    expect((await handlers.verifySelectionVersion(freshPng!.selectionId)).ok).toBe(true);
    expect((await handlers.verifySelectionVersion(docxSel!.selectionId)).ok).toBe(false);
  });

  it('keeps valid selections when other files in a batch fail header, extension, hidden, or symlink checks', async () => {
    const dir = makeTempDir();
    const skazData = join(dir, 'skaz-data');
    const hiddenDir = join(dir, '.secret');
    mkdirSync(skazData, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });

    const goodTxt = join(dir, 'readme.txt');
    const spoofedHeic = join(dir, 'fake.heic');
    const emptyDocx = join(dir, 'empty.docx');
    const hiddenDotfile = join(dir, '.env');
    const insideData = join(skazData, 'internal.png');
    const targetSecret = join(hiddenDir, 'secret.png');
    const symlinkToHidden = join(dir, 'innocent.png');

    writeFileSync(goodTxt, 'Hello SKAZ\n', 'utf8');
    writeFileSync(spoofedHeic, 'not a heic image at all');
    writeFileSync(emptyDocx, '');
    writeFileSync(hiddenDotfile, 'SECRET=1');
    writeFileSync(insideData, readFileSync(join(FIXTURES_DIR, 'sample-chart.png')));
    writeFileSync(targetSecret, readFileSync(join(FIXTURES_DIR, 'sample-chart.png')));
    symlinkSync(targetSecret, symlinkToHidden);

    const handlers = nativeIntakeHandlers(realDiskDeps({ skazDataDir: skazData }));
    const batch = await handlers.admitDroppedPaths([
      goodTxt,
      spoofedHeic,
      emptyDocx,
      hiddenDotfile,
      insideData,
      symlinkToHidden,
      'relative/file.png',
      join(dir, 'missing.jpg'),
    ]);

    expect(batch.accepted.map((a) => a.name)).toEqual(['readme.txt']);
    expect(batch.rejected).toEqual([
      { name: 'fake.heic', reason: "This file doesn't match a valid HEIC image.", source: 'drop' },
      { name: 'empty.docx', reason: 'This file is empty.', source: 'drop' },
      { name: '.env', reason: "Hidden files (their name starts with a dot) can't be added.", source: 'drop' },
      { name: 'internal.png', reason: "Files from SKAZ's own data folder can't be added.", source: 'drop' },
      { name: 'innocent.png', reason: "Files inside hidden folders can't be added.", source: 'drop' },
      { name: 'file.png', reason: 'The file path must be absolute.', source: 'drop' },
      { name: 'missing.jpg', reason: "This file doesn't exist any more or can't be opened.", source: 'drop' },
    ]);
  });

  it('rejects oversized files before reading contents into memory', async () => {
    const dir = makeTempDir();
    const bigImg = join(dir, 'huge.png');
    writeFileSync(bigImg, readFileSync(join(FIXTURES_DIR, 'sample-chart.png')));
    const readHeader = vi.fn(() => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const handlers = nativeIntakeHandlers(
      realDiskDeps({
        statFile: () => ({ isFile: true, size: MAX_IMAGE_BYTES + 1 }),
        readHeader,
      }),
    );

    const batch = await handlers.admitDroppedPaths([bigImg]);
    expect(batch.accepted).toEqual([]);
    expect(batch.rejected).toEqual([
      { name: 'huge.png', reason: 'This file is larger than 32 MB.', source: 'drop' },
    ]);
    expect(readHeader).not.toHaveBeenCalled();
  });

  it('validates clipboard image bytes by magic header and MIME without arbitrary path reads', () => {
    const handlers = nativeIntakeHandlers(realDiskDeps({ newId: () => 'clip-1' }));
    const pngBytes = readFileSync(join(FIXTURES_DIR, 'sample-chart.png'));
    const ab = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);

    expect(handlers.validateClipboardImage({ bytes: ab, mimeType: 'image/png', suggestedName: 'Screen Shot' })).toEqual({
      ok: true,
      selection: {
        selectionId: 'clip-1',
        name: 'Screen Shot.png',
        size: pngBytes.byteLength,
        formatId: 'png',
        mimeType: 'image/png',
        source: 'clipboard',
        nativePreviewable: true,
      },
    });

    // Spoofed MIME vs bytes
    expect(handlers.validateClipboardImage({ bytes: ab, mimeType: 'image/jpeg' })).toEqual({
      ok: false,
      reason: "The pasted data doesn't match a valid JPEG image.",
    });
    expect(handlers.validateClipboardImage({ bytes: new ArrayBuffer(0), mimeType: 'image/png' })).toEqual({
      ok: false,
      reason: 'The pasted image is empty.',
    });
  });

  it('preload boundary extracts paths strictly via webUtils.getPathForFile', async () => {
    const invoke = vi.fn(async () => ({ accepted: [], rejected: [] }));
    const boundary = createPreloadIntakeBoundary({
      getPathForFile: (file) => (file.name === 'chart.heic' ? '/Users/me/Downloads/chart.heic' : ''),
      invoke,
      channels: {
        chooseMaterialFiles: 'app:choose-material-files',
        droppedMaterialFiles: 'app:dropped-material-files',
        validateClipboardImage: 'app:validate-clipboard-image',
      },
    });

    const realDrop = { name: 'chart.heic' } as unknown as File;
    const browserFake = { name: 'synthetic.png' } as unknown as File;
    await boundary.droppedMaterialFiles([realDrop, browserFake]);
    expect(invoke).toHaveBeenCalledWith('app:dropped-material-files', ['/Users/me/Downloads/chart.heic']);

    // If no File has an OS path, IPC is not called
    invoke.mockClear();
    expect(await boundary.droppedMaterialFiles([browserFake])).toEqual({ accepted: [], rejected: [] });
    expect(invoke).not.toHaveBeenCalled();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('nativeIntake041 — async chunked hashing, batch ordering & responsiveness', () => {
  it('streams real multi-chunk disk files asynchronously and enforces file/size boundaries', async () => {
    const dir = makeTempDir();
    const multiChunkPng = join(dir, 'multi-chunk.png');
    const emptyFile = join(dir, 'empty.docx');
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const payload = Buffer.concat([pngHead, Buffer.alloc(160 * 1024, 0x2b)]); // > 2 * 64 KiB chunks
    writeFileSync(multiChunkPng, payload);
    writeFileSync(emptyFile, Buffer.alloc(0));

    const fp = await hashBoundedDiskFile(multiChunkPng, MAX_IMAGE_BYTES);
    expect(fp).not.toBeNull();
    expect(fp!.size).toBe(payload.length);
    expect(fp!.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(Array.from(fp!.head!.slice(0, 8))).toEqual(Array.from(pngHead));

    // Rejects missing, directory, empty, oversized, and truncated/changed-size mid-read
    expect(await hashBoundedDiskFile(join(dir, 'missing.docx'), MAX_DOCX_BYTES)).toBeNull();
    expect(await hashBoundedDiskFile(dir, MAX_DOCX_BYTES)).toBeNull();
    expect(await hashBoundedDiskFile(emptyFile, MAX_DOCX_BYTES)).toBeNull();
    expect(await hashBoundedDiskFile(multiChunkPng, payload.length - 1)).toBeNull();

    const mismatchHandle: BoundedDiskHandle = {
      stat: async () => ({ isFile: () => true, size: 100 }),
      read: async (buf, offset, _len, pos) => {
        if (pos > 0) return { bytesRead: 0 };
        buf.fill(0x41, offset, offset + 12);
        return { bytesRead: 12 };
      },
      close: async () => undefined,
    };
    expect(await hashBoundedDiskFile('/virtual/shrunk.docx', MAX_DOCX_BYTES, { openFile: async () => mismatchHandle })).toBeNull();
  });

  it('yields between chunks so an unrelated callback runs before a multi-chunk hash completes', async () => {
    const payload = Buffer.from('PK\x03\x04abcdefghijklmnopQRSTUVWX'); // 28 bytes across multiple 8-byte chunks
    const chunk2Gate = deferred<void>();
    const chunk2Started = deferred<void>();
    const events: string[] = [];
    let closed = false;

    const handle: BoundedDiskHandle = {
      stat: async () => ({ isFile: () => true, size: payload.length }),
      read: async (buf, offset, length, position) => {
        if (position >= payload.length) return { bytesRead: 0 };
        if (position === 0) {
          events.push('chunk-1-read');
        } else if (position === 8) {
          events.push('chunk-2-waiting');
          chunk2Started.resolve();
          await chunk2Gate.promise;
          events.push('chunk-2-resumed');
        }
        const n = Math.min(length, payload.length - position);
        payload.copy(buf, offset, position, position + n);
        return { bytesRead: n };
      },
      close: async () => {
        closed = true;
      },
    };

    let settled = false;
    const fpPromise = hashBoundedDiskFile('/virtual/multi.docx', MAX_DOCX_BYTES, {
      chunkBytes: 8,
      openFile: async () => handle,
    }).then((res) => {
      settled = true;
      events.push('hash-done');
      return res;
    });

    await chunk2Started.promise;
    expect(settled).toBe(false);

    // An unrelated callback scheduled on the event loop runs before the multi-chunk hash completes
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('unrelated-callback');
        resolve();
      }, 0);
    });
    expect(settled).toBe(false);

    chunk2Gate.resolve();
    const fp = await fpPromise;
    expect(closed).toBe(true);
    expect(fp).toEqual({
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      head: new Uint8Array(payload),
    });
    expect(events.indexOf('unrelated-callback')).toBeGreaterThan(events.indexOf('chunk-2-waiting'));
    expect(events.indexOf('unrelated-callback')).toBeLessThan(events.indexOf('hash-done'));
  });

  it('bounds concurrent batch hashing and preserves deterministic order even when files resolve out of order', async () => {
    const paths = [
      '/Users/me/d0.docx',
      '/Users/me/bad0.exe',
      '/Users/me/d1.docx',
      '/Users/me/d2.docx',
      '/Users/me/d3.docx',
      '/Users/me/d4.docx',
      '/Users/me/bad1.exe',
      '/Users/me/d5.docx',
      '/Users/me/d6.docx',
      '/Users/me/d7.docx',
    ];
    const validHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const gates = new Map<string, Deferred<BoundedFileFingerprint>>();
    let inFlight = 0;
    let maxInFlight = 0;
    let seq = 0;

    const handlers = nativeIntakeHandlers({
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [] })),
      realPath: (p) => p,
      statFile: () => ({ isFile: true, size: 128 }),
      readHeader: () => validHead,
      hashBoundedFile: async (p) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<BoundedFileFingerprint>();
        gates.set(p, gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      },
      downloadsDir: '/tmp',
      newId: () => `sel-${++seq}`,
    });

    const timeline: string[] = [];
    let batchSettled = false;
    const batchPromise = handlers.admitDroppedPaths(paths).then((batch) => {
      batchSettled = true;
      timeline.push('batch-done');
      return batch;
    });

    // Wait for first wave (capped at ADMIT_CONCURRENCY = 4)
    await vi.waitFor(() => expect(gates.size).toBe(ADMIT_CONCURRENCY));
    expect(inFlight).toBe(ADMIT_CONCURRENCY);
    expect(maxInFlight).toBe(ADMIT_CONCURRENCY);
    expect(batchSettled).toBe(false);

    // Unrelated work runs on the event loop while the multi-file batch is in flight
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timeline.push('unrelated-callback');
        resolve();
      }, 0);
    });
    expect(batchSettled).toBe(false);

    const fpFor = (name: string): BoundedFileFingerprint => ({
      size: 128,
      sha256: createHash('sha256').update(name).digest('hex'),
      head: validHead,
    });

    // Resolve wave 1 in reverse order (d3 -> d2 -> d1 -> d0)
    for (const name of ['d3.docx', 'd2.docx', 'd1.docx', 'd0.docx']) {
      const p = `/Users/me/${name}`;
      gates.get(p)!.resolve(fpFor(name));
      await nextMacrotask();
    }

    // Wait for wave 2 (remaining 4 docx files) and resolve out of order
    await vi.waitFor(() => expect(gates.size).toBe(8));
    expect(maxInFlight).toBe(ADMIT_CONCURRENCY);
    for (const name of ['d7.docx', 'd5.docx', 'd6.docx', 'd4.docx']) {
      const p = `/Users/me/${name}`;
      gates.get(p)!.resolve(fpFor(name));
    }

    const batch = await batchPromise;
    expect(maxInFlight).toBe(ADMIT_CONCURRENCY);
    expect(timeline).toEqual(['unrelated-callback', 'batch-done']);
    expect(batch.accepted.map((a) => [a.selectionId, a.name])).toEqual([
      ['sel-1', 'd0.docx'],
      ['sel-2', 'd1.docx'],
      ['sel-3', 'd2.docx'],
      ['sel-4', 'd3.docx'],
      ['sel-5', 'd4.docx'],
      ['sel-6', 'd5.docx'],
      ['sel-7', 'd6.docx'],
      ['sel-8', 'd7.docx'],
    ]);
    expect(batch.rejected.map((r) => r.name)).toEqual(['bad0.exe', 'bad1.exe']);
  });

  it('keeps the picker duplicate-open guard active until async admission finishes and yields during revalidation', async () => {
    const validHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const pickHashGate = deferred<BoundedFileFingerprint>();
    const recheckHashGate = deferred<BoundedFileFingerprint>();
    let hashCall = 0;
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/Users/me/lecture.docx'] }));

    const handlers = nativeIntakeHandlers({
      showOpenDialog,
      realPath: (p) => p,
      statFile: () => ({ isFile: true, size: 256 }),
      readHeader: () => validHead,
      hashBoundedFile: () => {
        hashCall += 1;
        return hashCall === 1 ? pickHashGate.promise : recheckHashGate.promise;
      },
      downloadsDir: '/tmp',
      newId: () => `tok-${hashCall}`,
    });

    const firstPick = handlers.chooseMaterialFiles();
    await vi.waitFor(() => expect(hashCall).toBe(1));

    // Second picker invocation while first admission is still hashing is ignored
    const duplicatePick = await handlers.chooseMaterialFiles();
    expect(duplicatePick).toEqual({ accepted: [], rejected: [] });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);

    const originalSha = createHash('sha256').update('v1').digest('hex');
    pickHashGate.resolve({ size: 256, sha256: originalSha, head: validHead });
    const picked = await firstPick;
    expect(picked.accepted).toHaveLength(1);
    const selId = picked.accepted[0]!.selectionId;

    // After admission finishes, revalidation also yields to unrelated callbacks and blocks same-size replacement
    let recheckDone = false;
    const events: string[] = [];
    const recheckPromise = handlers.verifySelectionVersion(selId).then((res) => {
      recheckDone = true;
      events.push('recheck-done');
      return res;
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push('unrelated-during-recheck');
        resolve();
      }, 0);
    });
    expect(recheckDone).toBe(false);

    const editedSha = createHash('sha256').update('v2').digest('hex');
    recheckHashGate.resolve({ size: 256, sha256: editedSha, head: validHead });
    const check = await recheckPromise;
    expect(check).toEqual({
      ok: false,
      status: 422,
      code: 'file_changed',
      detail: FILE_CHANGED_MESSAGE,
    });
    expect(events).toEqual(['unrelated-during-recheck', 'recheck-done']);
  });
});
