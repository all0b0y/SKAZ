// Pure main-process native intake policy, path scoping, and explicit selection registry.
// Kept free of direct Electron imports so it is deterministically unit-tested.

import { createHash, randomUUID } from 'node:crypto';
import type {
  ClipboardImageSelection,
  ClipboardImageValidation,
  MaterialIntakeBatch,
  RejectedMaterialSelection,
  SelectionSource,
  TrustedMaterialSelection,
} from './contracts';
export { createPreloadIntakeBoundary, type PreloadIntakeChannels } from './preloadBoundary';
import {
  baseName,
  classifyMaterialExtension,
  DOCUMENT_EXTENSIONS,
  HEADER_SNIFF_BYTES,
  IMAGE_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  MAX_CHOSEN_FILES,
  MAX_IMAGE_BYTES,
  sniffImageHeader,
  SPEECH_EXTENSIONS,
  verifyHeaderForExtension,
  type ClassifiedMaterialExtension,
  type ImageFormat,
  type IntakeCategory,
} from './formats';

export const FILE_CHANGED_MESSAGE =
  'The selected file changed after it was chosen. Choose the file again to preview or add it.';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export type MaybePromise<T> = T | Promise<T>;

export const ADMIT_CONCURRENCY = 4;

export interface FileStatResult {
  isFile: boolean;
  size: number;
}

export interface BoundedFileFingerprint {
  size: number;
  sha256: string;
  head?: Uint8Array;
}

export type SelectionVersionCheck =
  | { ok: true; selection: TrustedMaterialSelection }
  | { ok: false; status: 403 | 422; detail: string; code?: 'file_changed' };

export interface NativeIntakeDeps {
  showOpenDialog: (options: {
    title: string;
    defaultPath: string;
    properties: string[];
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  realPath: (path: string) => MaybePromise<string | null>;
  statFile: (path: string) => MaybePromise<FileStatResult | null>;
  readHeader: (path: string, maxBytes: number) => MaybePromise<Uint8Array | null>;
  readBoundedFile?: (path: string, maxBytes: number) => MaybePromise<Uint8Array | null>;
  hashBoundedFile?: (path: string, maxBytes: number) => MaybePromise<BoundedFileFingerprint | null>;
  downloadsDir: string;
  skazDataDir?: string;
  materialExtensions?: readonly string[];
  newId?: () => string;
}

const CLIPBOARD_MIME_TO_FORMAT: Record<string, { formatId: ImageFormat; ext: string; nativePreviewable: boolean }> = {
  'image/png': { formatId: 'png', ext: 'png', nativePreviewable: true },
  'image/jpeg': { formatId: 'jpeg', ext: 'jpg', nativePreviewable: true },
  'image/jpg': { formatId: 'jpeg', ext: 'jpg', nativePreviewable: true },
  'image/webp': { formatId: 'webp', ext: 'webp', nativePreviewable: true },
  'image/heic': { formatId: 'heic', ext: 'heic', nativePreviewable: false },
};

function isAbsolutePath(rawPath: string): boolean {
  return rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath);
}

function hasHiddenSegment(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) return 'Choose a file to add.';
  const fileName = parts[parts.length - 1]!;
  if (fileName.startsWith('.')) {
    return "Hidden files (their name starts with a dot) can't be added.";
  }
  const folders = parts.slice(0, -1);
  if (folders.some((seg) => seg.startsWith('.'))) {
    return "Files inside hidden folders can't be added.";
  }
  return null;
}

function isInsideDir(candidate: string, parentDir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(candidate);
  const d = norm(parentDir);
  if (!d) return false;
  return c === d || c.startsWith(`${d}/`);
}

function tooLargeMessage(maxBytes: number): string {
  const mb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
  return `This file is larger than ${mb} MB.`;
}

export interface ClipboardSelectionEntry {
  selection: ClipboardImageSelection;
  bytes: Uint8Array;
}

const MAX_CLIPBOARD_ENTRIES = 64;
const MAX_CLIPBOARD_TOTAL_BYTES = 128 * 1024 * 1024;

/**
 * Bounded registry of explicitly admitted selections. Prevents arbitrary path reads by ensuring
 * only selections returned from the native picker, preload `webUtils.getPathForFile`, or
 * validated clipboard pastes can be resolved or imported.
 */
export class TrustedSelectionStore {
  private readonly entries = new Map<string, TrustedMaterialSelection>();
  private readonly clipboardEntries = new Map<string, ClipboardSelectionEntry>();
  private clipboardTotalBytes = 0;
  private readonly maxEntries: number;

  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
  }

  admit(selection: TrustedMaterialSelection): TrustedMaterialSelection {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(selection.selectionId, selection);
    return selection;
  }

  admitClipboard(selection: ClipboardImageSelection, bytes: Uint8Array): ClipboardImageSelection {
    const copy = new Uint8Array(bytes);
    while (
      this.clipboardEntries.size >= MAX_CLIPBOARD_ENTRIES
      || (this.clipboardEntries.size > 0 && this.clipboardTotalBytes + copy.byteLength > MAX_CLIPBOARD_TOTAL_BYTES)
    ) {
      const oldest = this.clipboardEntries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.clipboardEntries.get(oldest);
      if (evicted) this.clipboardTotalBytes -= evicted.bytes.byteLength;
      this.clipboardEntries.delete(oldest);
    }
    this.clipboardEntries.set(selection.selectionId, { selection, bytes: copy });
    this.clipboardTotalBytes += copy.byteLength;
    return selection;
  }

  get(selectionId: string): TrustedMaterialSelection | null {
    if (typeof selectionId !== 'string' || !selectionId) return null;
    return this.entries.get(selectionId) ?? null;
  }

  getClipboard(selectionId: string): ClipboardSelectionEntry | null {
    if (typeof selectionId !== 'string' || !selectionId) return null;
    return this.clipboardEntries.get(selectionId) ?? null;
  }

  resolveTrustedPath(selectionId: string): string | null {
    return this.get(selectionId)?.path ?? null;
  }

  async readBoundedSelectionBytes(
    selectionId: string,
    deps: Pick<NativeIntakeDeps, 'statFile' | 'readBoundedFile'>,
    maxBytes: number,
  ): Promise<Uint8Array | null> {
    const entry = this.get(selectionId);
    if (!entry || !deps.readBoundedFile) return null;
    const st = await deps.statFile(entry.path);
    if (!st || !st.isFile || st.size <= 0 || st.size > maxBytes || st.size !== entry.size) return null;
    const bytes = await deps.readBoundedFile(entry.path, maxBytes);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.byteLength !== entry.size) {
      return null;
    }
    if (entry.sha256) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== entry.sha256.toLowerCase()) return null;
    }
    return bytes;
  }
}

export function requiresVersionBinding(category: IntakeCategory): boolean {
  return category === 'docx' || category === 'image';
}

async function computeSelectionFingerprint(
  resolvedPath: string,
  classified: ClassifiedMaterialExtension,
  deps: Pick<NativeIntakeDeps, 'hashBoundedFile' | 'readBoundedFile'>,
): Promise<BoundedFileFingerprint | null> {
  if (deps.hashBoundedFile) {
    const fp = await deps.hashBoundedFile(resolvedPath, classified.maxBytes);
    if (!fp || !Number.isSafeInteger(fp.size) || fp.size <= 0 || fp.size > classified.maxBytes) return null;
    if (!SHA256_HEX_RE.test(fp.sha256)) return null;
    return { size: fp.size, sha256: fp.sha256.toLowerCase(), head: fp.head };
  }
  if (deps.readBoundedFile) {
    const bytes = await deps.readBoundedFile(resolvedPath, classified.maxBytes);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > classified.maxBytes) return null;
    return {
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      head: bytes.subarray(0, Math.min(HEADER_SNIFF_BYTES, bytes.byteLength)),
    };
  }
  return null;
}

export async function verifyDiskSelectionVersion(
  entry: TrustedMaterialSelection,
  deps: Pick<NativeIntakeDeps, 'realPath' | 'statFile' | 'hashBoundedFile' | 'readBoundedFile' | 'skazDataDir'>,
): Promise<SelectionVersionCheck> {
  if (!requiresVersionBinding(entry.category)) {
    return { ok: true, selection: entry };
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_HEX_RE.test(entry.sha256)) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  const classified = classifyMaterialExtension(entry.path);
  if (!classified || classified.category !== entry.category) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  const resolved = await deps.realPath(entry.path);
  if (!resolved) {
    return { ok: false, status: 422, detail: "This file doesn't exist any more or can't be opened." };
  }
  if (resolved !== entry.path || hasHiddenSegment(resolved)) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  if (deps.skazDataDir) {
    const resolvedData = (await deps.realPath(deps.skazDataDir)) ?? deps.skazDataDir;
    if (isInsideDir(resolved, resolvedData)) {
      return { ok: false, status: 422, detail: "Files from SKAZ's own data folder can't be added." };
    }
  }
  const st = await deps.statFile(resolved);
  if (!st) {
    return { ok: false, status: 422, detail: "This file doesn't exist any more or can't be opened." };
  }
  if (!st.isFile || st.size <= 0 || st.size > classified.maxBytes || st.size !== entry.size) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  const fp = await computeSelectionFingerprint(resolved, classified, deps);
  if (!fp) {
    return { ok: false, status: 422, detail: "This file doesn't exist any more or can't be opened." };
  }
  if (fp.size !== entry.size || fp.sha256 !== entry.sha256.toLowerCase()) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  if (fp.head && verifyHeaderForExtension(fp.head, classified)) {
    return { ok: false, status: 422, code: 'file_changed', detail: FILE_CHANGED_MESSAGE };
  }
  return { ok: true, selection: entry };
}

type DiskSelectionDraft =
  | { ok: true; draft: Omit<TrustedMaterialSelection, 'selectionId'> }
  | { ok: false; rejected: RejectedMaterialSelection };

async function validateDiskSelectionDraft(
  rawPath: unknown,
  source: SelectionSource,
  deps: NativeIntakeDeps,
): Promise<DiskSelectionDraft> {
  const reject = (name: string, reason: string) => ({
    ok: false as const,
    rejected: { name, reason, source },
  });

  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    return reject('File', 'Choose a file to add.');
  }
  const displayName = baseName(rawPath) || 'File';
  if (!isAbsolutePath(rawPath)) {
    return reject(displayName, 'The file path must be absolute.');
  }
  const rawHidden = hasHiddenSegment(rawPath);
  if (rawHidden) {
    return reject(displayName, rawHidden);
  }

  const classified = classifyMaterialExtension(rawPath);
  const allowedExts = deps.materialExtensions
    ? new Set(deps.materialExtensions.map((e) => e.toLowerCase()))
    : null;
  if (!classified || (allowedExts && !allowedExts.has(classified.ext))) {
    const ext = /\.([^.\\/]+)$/.exec(displayName)?.[1]?.toLowerCase();
    const kind = ext ? `.${ext} files` : 'files without an extension';
    return reject(
      displayName,
      `SKAZ can't read ${kind}. It adds PDF, DOCX, Markdown (.md), text (.txt), images (JPEG, PNG, WebP, HEIC), and audio or video files.`,
    );
  }

  const resolved = await deps.realPath(rawPath);
  if (!resolved) {
    return reject(displayName, "This file doesn't exist any more or can't be opened.");
  }
  const resolvedHidden = hasHiddenSegment(resolved);
  if (resolvedHidden) {
    return reject(displayName, resolvedHidden);
  }
  if (deps.skazDataDir) {
    const resolvedData = (await deps.realPath(deps.skazDataDir)) ?? deps.skazDataDir;
    if (isInsideDir(resolved, resolvedData)) {
      return reject(displayName, "Files from SKAZ's own data folder can't be added.");
    }
  }

  const st = await deps.statFile(resolved);
  if (!st) {
    return reject(displayName, "This file doesn't exist any more or can't be opened.");
  }
  if (!st.isFile) {
    return reject(displayName, 'Choose a regular file.');
  }
  if (st.size <= 0) {
    return reject(displayName, 'This file is empty.');
  }
  if (st.size > classified.maxBytes) {
    return reject(displayName, tooLargeMessage(classified.maxBytes));
  }

  const head = await deps.readHeader(resolved, HEADER_SNIFF_BYTES);
  if (!head) {
    return reject(displayName, "SKAZ isn't allowed to read this file.");
  }
  const headerErr = verifyHeaderForExtension(head, classified);
  if (headerErr) {
    return reject(displayName, headerErr);
  }

  let verifiedSize = st.size;
  let sha256: string | undefined;
  if (requiresVersionBinding(classified.category)) {
    const fp = await computeSelectionFingerprint(resolved, classified, deps);
    if (!fp) {
      return reject(displayName, "SKAZ couldn't verify this file's contents.");
    }
    if (fp.head) {
      const fpHeaderErr = verifyHeaderForExtension(fp.head, classified);
      if (fpHeaderErr) {
        return reject(displayName, fpHeaderErr);
      }
    }
    verifiedSize = fp.size;
    sha256 = fp.sha256;
  }

  return {
    ok: true,
    draft: {
      path: resolved,
      name: displayName,
      size: verifiedSize,
      ...(sha256 ? { sha256 } : {}),
      ext: classified.ext,
      formatId: classified.formatId,
      category: classified.category,
      route: classified.route,
      mimeType: classified.mimeType,
      source,
      nativePreviewable: classified.nativePreviewable,
    },
  };
}

export async function validateDiskSelection(
  rawPath: unknown,
  source: SelectionSource,
  deps: NativeIntakeDeps,
): Promise<{ ok: true; selection: TrustedMaterialSelection } | { ok: false; rejected: RejectedMaterialSelection }> {
  const outcome = await validateDiskSelectionDraft(rawPath, source, deps);
  if (!outcome.ok) return outcome;
  const selectionId = deps.newId ? deps.newId() : `sel-${randomUUID()}`;
  return {
    ok: true,
    selection: {
      selectionId,
      ...outcome.draft,
    },
  };
}

export function nativeIntakeHandlers(deps: NativeIntakeDeps) {
  const store = new TrustedSelectionStore();
  let choosing = false;

  const admitMany = async (rawPaths: readonly unknown[], source: SelectionSource): Promise<MaterialIntakeBatch> => {
    const candidates = rawPaths.slice(0, MAX_CHOSEN_FILES);
    if (candidates.length === 0) return { accepted: [], rejected: [] };

    // Bound concurrent disk reads/hashes while preserving deterministic input order for IDs and batch output.
    const outcomes = new Array<DiskSelectionDraft>(candidates.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex++;
        outcomes[index] = await validateDiskSelectionDraft(candidates[index], source, deps);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ADMIT_CONCURRENCY, candidates.length) }, () => worker()));

    const accepted: TrustedMaterialSelection[] = [];
    const rejected: RejectedMaterialSelection[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        const selectionId = deps.newId ? deps.newId() : `sel-${randomUUID()}`;
        accepted.push(store.admit({ selectionId, ...outcome.draft }));
      } else {
        rejected.push(outcome.rejected);
      }
    }
    return { accepted, rejected };
  };

  return {
    store,

    async chooseMaterialFiles(): Promise<MaterialIntakeBatch> {
      if (choosing) return { accepted: [], rejected: [] };
      choosing = true;
      try {
        const exts = [...(deps.materialExtensions ?? MATERIAL_EXTENSIONS)];
        const result = await deps.showOpenDialog({
          title: 'Choose materials',
          defaultPath: deps.downloadsDir,
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Supported materials', extensions: exts },
            { name: 'Documents', extensions: [...DOCUMENT_EXTENSIONS] },
            { name: 'Images', extensions: [...IMAGE_EXTENSIONS] },
            { name: 'Audio and video', extensions: [...SPEECH_EXTENSIONS] },
          ],
        });
        if (result.canceled) return { accepted: [], rejected: [] };
        return await admitMany(result.filePaths, 'picker');
      } catch {
        return { accepted: [], rejected: [] };
      } finally {
        choosing = false;
      }
    },

    admitDroppedPaths(rawPaths: unknown): Promise<MaterialIntakeBatch> {
      if (!Array.isArray(rawPaths)) return Promise.resolve({ accepted: [], rejected: [] });
      return admitMany(rawPaths, 'drop');
    },

    validateClipboardImage(payload: unknown): ClipboardImageValidation {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: 'The pasted image is missing.' };
      }
      const p = payload as { bytes?: unknown; mimeType?: unknown; suggestedName?: unknown };
      const isCrossRealmAb = Object.prototype.toString.call(p.bytes) === '[object ArrayBuffer]';
      let view: Uint8Array;
      if (p.bytes instanceof ArrayBuffer || isCrossRealmAb) {
        view = new Uint8Array(p.bytes as ArrayBuffer);
      } else if (ArrayBuffer.isView(p.bytes)) {
        view = new Uint8Array(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
      } else {
        return { ok: false, reason: 'The pasted image is missing.' };
      }
      if (view.byteLength === 0) {
        return { ok: false, reason: 'The pasted image is empty.' };
      }
      if (view.byteLength > MAX_IMAGE_BYTES) {
        return { ok: false, reason: tooLargeMessage(MAX_IMAGE_BYTES) };
      }
      const mime = typeof p.mimeType === 'string' ? p.mimeType.split(';', 1)[0]!.trim().toLowerCase() : '';
      const meta = CLIPBOARD_MIME_TO_FORMAT[mime];
      if (!meta) {
        return { ok: false, reason: `Unsupported clipboard image type (${mime || 'unknown'}).` };
      }
      const head = view.subarray(0, Math.min(HEADER_SNIFF_BYTES, view.byteLength));
      const detected = sniffImageHeader(head);
      if (detected !== meta.formatId) {
        return { ok: false, reason: `The pasted data doesn't match a valid ${meta.formatId.toUpperCase()} image.` };
      }
      const rawName = typeof p.suggestedName === 'string' && p.suggestedName.trim()
        ? baseName(p.suggestedName.trim()).replace(/\.\w+$/, '')
        : 'Screenshot';
      const selectionId = deps.newId ? deps.newId() : `sel-${randomUUID()}`;
      const selection: ClipboardImageSelection = {
        selectionId,
        name: `${rawName || 'Screenshot'}.${meta.ext}`,
        size: view.byteLength,
        formatId: meta.formatId,
        mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime,
        source: 'clipboard',
        nativePreviewable: meta.nativePreviewable,
      };
      store.admitClipboard(selection, view);
      return {
        ok: true,
        selection,
      };
    },

    getClipboardSelection(selectionId: string): ClipboardSelectionEntry | null {
      return store.getClipboard(selectionId);
    },

    resolveTrustedPath(selectionId: string): string | null {
      return store.resolveTrustedPath(selectionId);
    },

    async verifySelectionVersion(selectionId: string): Promise<SelectionVersionCheck> {
      const entry = store.get(selectionId);
      if (!entry) {
        return { ok: false, status: 403, detail: 'This file selection is not authorized.' };
      }
      return verifyDiskSelectionVersion(entry, deps);
    },

    async readBoundedPreviewBytes(selectionId: string, maxBytes = MAX_IMAGE_BYTES): Promise<Uint8Array | null> {
      const entry = store.get(selectionId);
      if (!entry || entry.category !== 'image') return null;
      return store.readBoundedSelectionBytes(selectionId, deps, Math.min(maxBytes, MAX_IMAGE_BYTES));
    },
  };
}
