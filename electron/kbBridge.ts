// Main-process side of the three package-2 bridge methods (API-B2 §5): dictation, saving a text
// file through the native dialog, choosing material files. Electron-free (dependencies are
// injected), so the policy is unit-tested; ipc.ts wires the real dialog/fs/fetch.

import type { DictationResult, JsonResponse, MaterialFileChoice, TextFileSave } from '../frontend/src/api/bridge';
import type {
  ClipboardImageValidation,
  MaterialIntakeBatch,
  NativeIntakeImagePreview,
  NativeIntakeImportRequest,
} from './nativeIntake041/contracts';
import { nativeIntakeHandlers, type BoundedFileFingerprint, type MaybePromise } from './nativeIntake041/trustedIntake';

/** One dictation clip: PCM16 mono WAV, at most 8 MB and 120 seconds (the backend limit). */
export const MAX_DICTATION_BYTES = 8 * 1024 * 1024;
export const MAX_DICTATION_SECONDS = 120;
/** A saved text (chat export) — the user already sees it; this only bounds its size. */
export const MAX_SAVE_TEXT_CHARS = 5 * 1024 * 1024;
const MAX_FILE_NAME = 120;

/**
 * Checks the clip before it leaves main: a canonical RIFF/WAVE header, PCM16 mono, within the size
 * and duration limits; `language` is a plain language code. Returns the reason to refuse, or null.
 */
export function validateDictation(wav: unknown, language: unknown): string | null {
  if (!(wav instanceof ArrayBuffer)) return 'Dictation audio is missing.';
  if (wav.byteLength <= 44) return 'Dictation audio is empty.';
  if (wav.byteLength > MAX_DICTATION_BYTES) return 'Dictation is too long: up to 2 minutes at a time.';
  const view = new DataView(wav);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return 'Dictation audio is not a WAV clip.';
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || rate < 8000 || rate > 48_000) return 'Dictation audio must be 16-bit mono PCM.';
  if (dataBytes > wav.byteLength - 44) return 'Dictation audio is cut short.';
  if (dataBytes / (rate * 2) > MAX_DICTATION_SECONDS + 0.5) return 'Dictation is too long: up to 2 minutes at a time.';
  if (language !== undefined && language !== null && (typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language))) {
    return 'Unknown dictation language.';
  }
  return null;
}

/**
 * A bare file name for the save dialog's suggestion: no folders, no traversal, no control
 * characters, `.md` unless the name already ends in `.md`/`.txt`. Null when nothing usable is left.
 */
export function saveFileName(suggested: unknown): string | null {
  if (typeof suggested !== 'string') return null;
  let base = suggested.replace(/[/\\:]/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < base.length; i += 1) if (base.charCodeAt(i) < 0x20 || base.charCodeAt(i) === 0x7f) return null;
  const ext = /\.(md|txt)$/i.exec(base)?.[0]?.toLowerCase() ?? '.md';
  base = base.replace(/\.(md|txt)$/i, '').replace(/^\.+/, '').replace(/[ .]+$/, '').slice(0, MAX_FILE_NAME).trim();
  return base ? `${base}${ext}` : null;
}

export function validateSaveText(file: unknown): string | null {
  const f = file as Partial<TextFileSave> | null;
  if (!f || typeof f !== 'object' || typeof f.text !== 'string') return 'Nothing to save.';
  if (f.text.length > MAX_SAVE_TEXT_CHARS) return 'The text is too large to save.';
  if (!saveFileName(f.suggested_name)) return 'Invalid file name.';
  return null;
}

export interface KbBridgeDeps {
  /** Loopback backend of this run; null until it is ready. */
  handle: () => { port: number; token: string } | null;
  fetch: typeof fetch;
  showSaveDialog: (options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog: (options: { title: string; defaultPath: string; properties: string[]; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  writeTextFile: (path: string, text: string) => void;
  fileSize: (path: string) => MaybePromise<number | null>;
  realPath: (path: string) => MaybePromise<string | null>;
  readHeader: (path: string, maxBytes: number) => MaybePromise<Uint8Array | null>;
  readBoundedFile?: (path: string, maxBytes: number) => MaybePromise<Uint8Array | null>;
  hashBoundedFile?: (path: string, maxBytes: number) => MaybePromise<BoundedFileFingerprint | null>;
  documentsDir: string;
  downloadsDir: string;
  skazDataDir?: string;
  materialExtensions: readonly string[];
  newId?: () => string;
}

async function readFailure(res: Response): Promise<{ detail: string; code?: string }> {
  try {
    const body = (await res.json()) as { detail?: unknown; error_code?: unknown; code?: unknown };
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`;
    const code = typeof body?.error_code === 'string' ? body.error_code
      : typeof body?.code === 'string' ? body.code : undefined;
    return code === undefined ? { detail } : { detail, code };
  } catch {
    return { detail: `HTTP ${res.status}` };
  }
}

/** Main-process bridge handlers, each already behind the trusted-sender check in ipc.ts. */
export function kbBridgeHandlers(deps: KbBridgeDeps) {
  let saving = false;
  const intake = nativeIntakeHandlers({
    showOpenDialog: deps.showOpenDialog,
    realPath: deps.realPath,
    statFile: async (path) => {
      const size = await deps.fileSize(path);
      return size === null ? null : { isFile: true, size };
    },
    readHeader: deps.readHeader,
    readBoundedFile: deps.readBoundedFile,
    hashBoundedFile: deps.hashBoundedFile,
    downloadsDir: deps.downloadsDir,
    skazDataDir: deps.skazDataDir,
    materialExtensions: deps.materialExtensions,
    newId: deps.newId,
  });

  async function postJson(
    handle: { port: number; token: string },
    path: string,
    body: unknown,
  ): Promise<JsonResponse<unknown>> {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return { ok: false, status: res.status, ...(await readFailure(res)) };
      const text = await res.text();
      return { ok: true, status: res.status, data: text.length > 0 ? (JSON.parse(text) as unknown) : null };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    async dictate(wav: unknown, language: unknown): Promise<JsonResponse<DictationResult>> {
      const error = validateDictation(wav, language);
      if (error) return { ok: false, status: 0, detail: error };
      const handle = deps.handle();
      if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
      try {
        const url = new URL(`http://127.0.0.1:${handle.port}/kb/dictation`);
        if (typeof language === 'string') url.searchParams.set('language', language);
        const res = await deps.fetch(url.toString(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'audio/wav' },
          body: Buffer.from(wav as ArrayBuffer),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) return { ok: false, status: res.status, ...(await readFailure(res)) };
        const data = (await res.json()) as DictationResult;
        return { ok: true, status: res.status, data };
      } catch (err) {
        return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async saveTextFile(file: unknown): Promise<{ saved: boolean; path?: string }> {
      if (validateSaveText(file) || saving) return { saved: false };
      const { suggested_name, text } = file as TextFileSave;
      const name = saveFileName(suggested_name)!;
      saving = true;
      try {
        const result = await deps.showSaveDialog({
          title: 'Save as', defaultPath: `${deps.documentsDir}/${name}`,
          filters: [{ name: name.endsWith('.txt') ? 'Text' : 'Markdown', extensions: [name.endsWith('.txt') ? 'txt' : 'md'] }],
        });
        if (result.canceled || !result.filePath) return { saved: false };
        deps.writeTextFile(result.filePath, text);
        return { saved: true, path: result.filePath };
      } catch {
        return { saved: false };
      } finally {
        saving = false;
      }
    },

    async chooseMaterialFiles(): Promise<MaterialFileChoice[]> {
      const batch = await intake.chooseMaterialFiles();
      return batch.accepted.map((item) => ({ path: item.path, name: item.name, size: item.size }));
    },

    async chooseMaterialBatch(): Promise<MaterialIntakeBatch> {
      return intake.chooseMaterialFiles();
    },

    droppedMaterialFiles(rawPaths: unknown): Promise<MaterialIntakeBatch> {
      return intake.admitDroppedPaths(rawPaths);
    },

    validateClipboardImage(payload: unknown): ClipboardImageValidation {
      return intake.validateClipboardImage(payload);
    },

    async importSelection(rawRequest: unknown): Promise<JsonResponse<unknown>> {
      if (!rawRequest || typeof rawRequest !== 'object') {
        return { ok: false, status: 400, detail: 'Missing import selection request.' };
      }
      const req = rawRequest as Partial<NativeIntakeImportRequest>;
      if (typeof req.selectionId !== 'string' || !req.selectionId) {
        return { ok: false, status: 400, detail: 'Invalid selectionId.' };
      }
      if (typeof req.folderId !== 'string' || !req.folderId || req.folderId.length > 64) {
        return { ok: false, status: 400, detail: 'Invalid folderId.' };
      }
      const handle = deps.handle();
      if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };

      const disk = intake.store.get(req.selectionId);
      if (disk) {
        if (disk.route === 'speech') {
          return postJson(handle, '/kb/imports', {
            path: disk.path,
            folder_id: req.folderId,
            title: typeof req.title === 'string' ? req.title : null,
            language: typeof req.language === 'string' ? req.language : null,
            translate: req.translate === true,
            to_wiki: typeof req.toWiki === 'boolean' ? req.toWiki : null,
          });
        }
        const verified = await intake.verifySelectionVersion(req.selectionId);
        if (!verified.ok) {
          return {
            ok: false,
            status: verified.status,
            detail: verified.detail,
            ...(verified.code ? { code: verified.code } : {}),
          };
        }
        const checked = verified.selection;
        return postJson(handle, '/kb/materials/file', {
          path: checked.path,
          folder_id: req.folderId,
          title: typeof req.title === 'string' ? req.title : null,
          to_wiki: checked.route === 'image' ? false : (typeof req.toWiki === 'boolean' ? req.toWiki : null),
          selection_source: checked.source,
          expected_size: checked.size,
          ...(checked.sha256 ? { expected_sha256: checked.sha256 } : {}),
        });
      }

      const clip = intake.getClipboardSelection(req.selectionId);
      if (clip) {
        try {
          const url = new URL(`http://127.0.0.1:${handle.port}/kb/materials/clipboard-image`);
          url.searchParams.set('folder_id', req.folderId);
          url.searchParams.set('file_name', clip.selection.name);
          if (typeof req.title === 'string' && req.title.trim()) {
            url.searchParams.set('title', req.title);
          }
          const res = await deps.fetch(url.toString(), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${handle.token}`,
              'Content-Type': clip.selection.mimeType,
            },
            body: Buffer.from(clip.bytes),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) return { ok: false, status: res.status, ...(await readFailure(res)) };
          const text = await res.text();
          return { ok: true, status: res.status, data: text.length > 0 ? (JSON.parse(text) as unknown) : null };
        } catch (err) {
          return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
        }
      }

      return { ok: false, status: 403, detail: 'This file selection is not authorized.' };
    },

    async imagePreview(selectionId: unknown): Promise<JsonResponse<NativeIntakeImagePreview>> {
      if (typeof selectionId !== 'string' || !selectionId) {
        return { ok: false, status: 400, detail: 'Invalid selectionId.' };
      }
      const disk = intake.store.get(selectionId);
      if (disk && disk.category === 'image') {
        const handle = deps.handle();
        if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
        const verified = await intake.verifySelectionVersion(selectionId);
        if (!verified.ok) {
          return {
            ok: false,
            status: verified.status,
            detail: verified.detail,
            ...(verified.code ? { code: verified.code } : {}),
          };
        }
        const checked = verified.selection;
        try {
          const res = await deps.fetch(`http://127.0.0.1:${handle.port}/kb/materials/image-preview`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: checked.path,
              expected_size: checked.size,
              ...(checked.sha256 ? { expected_sha256: checked.sha256 } : {}),
            }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) return { ok: false, status: res.status, ...(await readFailure(res)) };
          const bytes = new Uint8Array(await res.arrayBuffer());
          return { ok: true, status: 200, data: { mimeType: 'image/png', bytes } };
        } catch (err) {
          return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
        }
      }

      const clip = intake.getClipboardSelection(selectionId);
      if (clip && clip.selection.nativePreviewable) {
        return {
          ok: true,
          status: 200,
          data: {
            mimeType: clip.selection.mimeType as NativeIntakeImagePreview['mimeType'],
            bytes: new Uint8Array(clip.bytes),
          },
        };
      }

      return { ok: false, status: 403, detail: 'Image preview is only available for authorized image selections.' };
    },
  };
}
