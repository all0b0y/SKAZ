// Main-process side of the three package-2 bridge methods (API-B2 §5): dictation, saving a text
// file through the native dialog, choosing material files. Electron-free (dependencies are
// injected), so the policy is unit-tested; ipc.ts wires the real dialog/fs/fetch.

import type { DictationResult, JsonResponse, MaterialFileChoice, TextFileSave } from '../frontend/src/api/bridge';

/** One dictation clip: PCM16 mono WAV, at most 8 MB and 120 seconds (the backend limit). */
export const MAX_DICTATION_BYTES = 8 * 1024 * 1024;
export const MAX_DICTATION_SECONDS = 120;
/** A saved text (chat export) — the user already sees it; this only bounds its size. */
export const MAX_SAVE_TEXT_CHARS = 5 * 1024 * 1024;
const MAX_FILE_NAME = 120;
const MAX_CHOSEN_FILES = 50;

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
  fileSize: (path: string) => number | null;
  documentsDir: string;
  downloadsDir: string;
  materialExtensions: readonly string[];
}

async function readDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The three handlers, each already behind the trusted-sender check in ipc.ts. */
export function kbBridgeHandlers(deps: KbBridgeDeps) {
  let saving = false;
  let choosing = false;
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
        if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
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
      if (choosing) return [];
      choosing = true;
      try {
        const result = await deps.showOpenDialog({
          title: 'Choose materials', defaultPath: deps.downloadsDir,
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Documents, audio and video', extensions: [...deps.materialExtensions] }],
        });
        if (result.canceled) return [];
        const allowed = new Set(deps.materialExtensions.map((e) => e.toLowerCase()));
        const out: MaterialFileChoice[] = [];
        for (const path of result.filePaths.slice(0, MAX_CHOSEN_FILES)) {
          const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
          if (!ext || !allowed.has(ext)) continue;
          const size = deps.fileSize(path);
          if (size === null) continue;
          out.push({ path, name: baseName(path), size });
        }
        return out;
      } catch {
        return [];
      } finally {
        choosing = false;
      }
    },
  };
}
