import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHANNELS } from './channels';
import { NativeLiveClient } from './nativeLive';
import type { NativeAudioMeta, NativeFailure } from '../frontend/src/api/nativeLive';
import type { BackendManager } from './backend';
import { REQUEST_TIMEOUT_MS, validateBridgeRequest } from './ipcPolicy';
import { isTrustedFrame } from './ipcSender';
import { kbBridgeHandlers } from './kbBridge';
import { ExportFolders, obsidianInstalled, openInObsidian, resolveTarget, type LibraryActionDeps } from './libraryActions';
import { mediaAccessOf, privacySettingsUrl } from './systemAudio';
import type { AudioFileChoice, BridgeRequest, HttpMethod, JsonResponse } from '../frontend/src/api/bridge';
import { MATERIAL_EXTENSIONS, SPEECH_EXTENSIONS } from '../frontend/src/api/bridge';

// Registers the request-scoped IPC handlers. Every call is proxied to the
// loopback backend with the per-run bearer token attached here in main, so the
// renderer never sees the token and can only reach the backend. Every handler
// also verifies the message came from the main frame of the expected main
// window before doing anything.

const ALLOWED_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** A window-id getter so the guard tracks the current main window lazily. */
type ExpectedWebContentsId = () => number | null;

function buildUrl(port: number, path: string, query?: BridgeRequest['query']): string {
  if (!path.startsWith('/')) {
    throw new Error(`invalid path: ${path}`);
  }
  const url = new URL(`http://127.0.0.1:${port}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function readDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function registerIpc(
  manager: BackendManager,
  expectedId: ExpectedWebContentsId,
  onNativeFailure?: (failure: NativeFailure) => void,
): NativeLiveClient {
  const native = new NativeLiveClient(() => manager.getHandle(), onNativeFailure);
  const senderTrusted = (event: IpcMainInvokeEvent): boolean =>
    isTrustedFrame({
      senderId: event.sender.id,
      expectedId: expectedId(),
      isMainFrame: event.senderFrame?.parent === null,
    });

  async function nativeReply<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<JsonResponse<T>> {
    if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
    try {
      return { ok: true, status: 200, data: await operation() };
    } catch {
      return { ok: false, status: 0, detail: 'Native stream operation failed; check saved coverage before retry.' };
    }
  }
  ipcMain.handle(CHANNELS.nativeOpen, (event, id: string, rate: number) =>
    nativeReply(event, () => native.open(id, rate)));
  ipcMain.handle(CHANNELS.nativeAudio, (event, id: string, meta: NativeAudioMeta, pcm: ArrayBuffer) =>
    nativeReply(event, () => native.audio(id, meta, pcm)));
  ipcMain.handle(CHANNELS.nativeEnd, (event, id: string, action: 'pause' | 'stop') =>
    nativeReply(event, () => native.end(id, action)));

  ipcMain.handle(CHANNELS.status, (event) => {
    if (!senderTrusted(event)) return { phase: 'error', detail: 'untrusted sender' };
    return manager.getStatus();
  });

  let choosingRoot = false;
  ipcMain.handle(CHANNELS.chooseStorageRoot, async (event): Promise<string | null> => {
    if (!senderTrusted(event) || choosingRoot) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    choosingRoot = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: 'Choose where the SKAZ library lives', buttonLabel: 'Choose', defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    } catch {
      throw new Error('Folder chooser unavailable.');
    } finally {
      choosingRoot = false;
    }
  });

  let choosingAudio = false;
  ipcMain.handle(CHANNELS.chooseAudioFile, async (event): Promise<AudioFileChoice | null> => {
    if (!senderTrusted(event) || choosingAudio) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    choosingAudio = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: 'Choose an audio or video file',
        defaultPath: app.getPath('downloads'),
        // One file per import: each import is one priced confirmation.
        properties: ['openFile'],
        filters: [{ name: 'Audio and video', extensions: [...SPEECH_EXTENSIONS] }],
      });
      const chosen = result.canceled ? null : result.filePaths[0] ?? null;
      if (!chosen) return null;
      // The renderer needs a playable URL only to read the duration from the
      // container metadata; the bytes themselves are never sent through IPC.
      return { path: chosen, name: basename(chosen) };
    } catch {
      throw new Error('The file dialog is unavailable.');
    } finally {
      choosingAudio = false;
    }
  });

  // Knowledge interface (API-B2 §5): dictation clip → POST /kb/dictation with this run's token;
  // chat export through the native save dialog; material files through the native chooser.
  const kb = kbBridgeHandlers({
    handle: () => manager.getHandle(),
    fetch: (input, init) => fetch(input, init),
    showSaveDialog: async (options) => {
      const owner = BrowserWindow.getFocusedWindow();
      return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
    },
    showOpenDialog: async (options) => {
      const owner = BrowserWindow.getFocusedWindow();
      const props = options.properties as Array<'openFile' | 'multiSelections'>;
      return owner ? dialog.showOpenDialog(owner, { ...options, properties: props })
        : dialog.showOpenDialog({ ...options, properties: props });
    },
    writeTextFile: (path, text) => writeFileSync(path, text, { encoding: 'utf8' }),
    fileSize: (path) => {
      try { const st = statSync(path); return st.isFile() ? st.size : null; } catch { return null; }
    },
    documentsDir: app.getPath('documents'),
    downloadsDir: app.getPath('downloads'),
    materialExtensions: MATERIAL_EXTENSIONS,
  });
  ipcMain.handle(CHANNELS.dictate, (event, wav: unknown, language: unknown) => {
    if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
    return kb.dictate(wav, language);
  });
  ipcMain.handle(CHANNELS.saveTextFile, (event, file: unknown) => {
    if (!senderTrusted(event)) return { saved: false };
    return kb.saveTextFile(file);
  });
  ipcMain.handle(CHANNELS.chooseMaterialFiles, (event) => {
    if (!senderTrusted(event)) return [];
    return kb.chooseMaterialFiles();
  });

  // Library file actions (B20): the renderer names a target, main finds and checks the path.
  const exportFolders = new ExportFolders({
    read: () => { try { return readFileSync(join(app.getPath('userData'), 'export-folders.json'), 'utf8'); } catch { return null; } },
    write: (text) => writeFileSync(join(app.getPath('userData'), 'export-folders.json'), text, { encoding: 'utf8', mode: 0o600 }),
  });
  const actionDeps: LibraryActionDeps = {
    getJson: async (route) => {
      const handle = manager.getHandle();
      if (!handle) return null;
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}${route}`, {
          headers: { Authorization: `Bearer ${handle.token}` }, signal: AbortSignal.timeout(10_000),
        });
        return res.ok ? await res.json() as unknown : null;
      } catch {
        return null;
      }
    },
    realPath: (p) => { try { return realpathSync(p); } catch { return null; } },
    isDirectory: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
    isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  };
  let choosingExport = false;
  ipcMain.handle(CHANNELS.chooseExportFolder, async (event): Promise<string | null> => {
    if (!senderTrusted(event) || choosingExport) return null;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    choosingExport = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        title: 'Choose a folder for the export', buttonLabel: 'Export here', defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      const chosen = result.canceled ? null : result.filePaths[0] ?? null;
      if (chosen) exportFolders.remember(chosen);
      return chosen;
    } catch {
      return null;
    } finally {
      choosingExport = false;
    }
  });
  ipcMain.handle(CHANNELS.showInFinder, async (event, target: unknown) => {
    if (!senderTrusted(event)) return false;
    const resolved = await resolveTarget(target, actionDeps, exportFolders);
    if (!resolved) return false;
    if (resolved.directory) return (await shell.openPath(resolved.path)) === '';
    shell.showItemInFolder(resolved.path);
    return true;
  });

  ipcMain.handle(CHANNELS.openInObsidian, async (event, target: unknown) => {
    if (!senderTrusted(event)) return { ok: false, reason: 'unavailable' };
    return openInObsidian(target, {
      ...actionDeps,
      installed: () => obsidianInstalled(app.getPath('home'), existsSync, () => app.getApplicationNameForProtocol('obsidian://')),
      openExternal: (url) => shell.openExternal(url),
    }, exportFolders);
  });

  // Fixed destinations only: the renderer names a pane, main picks the System Settings URL.
  ipcMain.handle(CHANNELS.openSystemAudioSettings, async (event, pane: unknown) => {
    if (!senderTrusted(event)) return false;
    const url = privacySettingsUrl(process.platform, pane);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });

  // Read-only privacy state for Settings → Sound; never asks for anything.
  ipcMain.handle(CHANNELS.mediaAccess, (event) => {
    if (!senderTrusted(event)) return mediaAccessOf('untrusted', () => 'unknown');
    return mediaAccessOf(process.platform, (kind) => systemPreferences.getMediaAccessStatus(kind));
  });

  ipcMain.handle(CHANNELS.openLogsFolder, async (event) => {
    if (!senderTrusted(event)) return false;
    const log = manager.getLog();
    mkdirSync(log.directory, { recursive: true });
    await shell.openPath(log.directory);
    return true;
  });

  // Try again after a failed start; the manager refuses unless the last start failed.
  ipcMain.handle(CHANNELS.restartBackend, (event) => {
    if (!senderTrusted(event)) return false;
    return manager.restart();
  });

  ipcMain.handle(CHANNELS.request, async (event, req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
    const handle = manager.getHandle();
    if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
    if (!ALLOWED_METHODS.includes(req.method)) {
      return { ok: false, status: 0, detail: `method not allowed: ${req.method}` };
    }
    const policyError = validateBridgeRequest(req);
    if (policyError) return { ok: false, status: 0, detail: policyError };
    try {
      const url = buildUrl(handle.port, req.path, req.query);
      const hasBody = req.body !== undefined && req.method !== 'GET';
      const res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${handle.token}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
      const text = await res.text();
      const data = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  return native;
}
