import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendManager } from './backend';
import { registerIpc } from './ipc';
import type { NativeLiveClient } from './nativeLive';
import { CHANNELS } from './channels';
import { isAllowedExternalUrl } from './ipcPolicy';
import { hasUnsentAudio, type CaptureProtectionState } from './captureProtection';
import { displayMediaGrant, isTrustedMediaCheck, isTrustedMediaRequest } from './permissionPolicy';
import { isTrustedFrame, validateCaptureState, validateCodexActivity } from './ipcSender';
import { QuitController } from './quitController';
import { RendererSaveBarrier } from './rendererSaveBarrier';
import { readDeclinedForever, shouldOfferMoveToApplications, writeDeclinedForever } from './installLocation';
import type { BackendStatus } from '../frontend/src/api/bridge';

// electron-vite injects ELECTRON_RENDERER_URL in dev.
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;
const isDev = Boolean(RENDERER_DEV_URL);

const thisDir =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
// dist/main -> repo root
const REPO_ROOT = isDev ? process.cwd() : path.resolve(thisDir, '..', '..');
const PRELOAD = path.join(thisDir, '..', 'preload', 'preload.js');
const RENDERER_HTML = path.join(thisDir, '..', 'renderer', 'index.html');
// Only meaningful unpackaged: a packaged .app takes its icon from the bundle's
// .icns, and the repo-relative PNG does not exist inside the bundle.
const APP_ICON = path.join(REPO_ROOT, 'icon', 'icon.png');

// Exact renderer identity for trust checks. Parsed-equality, never prefix match.
const EXPECTED_RENDERER_URL = isDev && RENDERER_DEV_URL ? RENDERER_DEV_URL : `file://${RENDERER_HTML}`;
const EXPECTED_RENDERER_ORIGIN =
  isDev && RENDERER_DEV_URL ? new URL(RENDERER_DEV_URL).origin : 'file://';

const CSP =
  "default-src 'self'; script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
  "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let mainWindow: BrowserWindow | null = null;
let nativeClient: NativeLiveClient | null = null;

// SKAZ owns its own store under the product-named userData directory. It is
// created on first run; nothing is inherited from any earlier install.
const DATA_DIR = path.join(app.getPath('userData'), 'data');

// Latest capture snapshot reported by the renderer (validated). Consulted on
// close/quit so unsent audio is never dropped without a warning.
let captureState: CaptureProtectionState = { recorderState: 'idle', pending: 0, failed: 0 };
// Active Codex tasks last reported by the renderer; only decides whether quit warns.
let codexActiveTasks = 0;

const manager = new BackendManager({
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  onStatus: (status: BackendStatus) => {
    mainWindow?.webContents.send(CHANNELS.statusEvent, status);
  },
});

// Single authority for close/quit: authorize (warn) before any shutdown, keep
// the backend alive on cancel, and never double-dialog or double-shutdown.
const rendererSave = new RendererSaveBarrier((id) => {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) throw new Error('Renderer unavailable');
  mainWindow.webContents.send(CHANNELS.prepareQuit, id);
});

const quitController = new QuitController({
  saveBeforeQuit: () => mainWindow ? rendererSave.request() : Promise.resolve(!hasUnsentAudio(captureState)),
  onCancelQuit: () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(CHANNELS.cancelQuit);
  },
  hasUnsentAudio: () => hasUnsentAudio(captureState),
  confirmDiscard: () => {
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: ['Stay in SKAZ', 'Discard unsaved audio and quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Saving before exit could not be confirmed',
      detail:
        'Some captured audio has not been saved yet. Quitting now may lose it. ' +
        'Stay to retry saving, or explicitly discard unsaved audio and quit.',
    };
    const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, options) : dialog.showMessageBoxSync(options);
    return choice === 1;
  },
  hasActiveTasks: () => codexActiveTasks > 0,
  confirmStopTasks: () => {
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: ['Stay', 'Stop tasks and quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Codex is still running tasks',
      detail:
        'Quitting stops the tasks. Requests, partial answers and the queue are kept; ' +
        'after relaunch you can resume them manually — they do not resume by themselves.',
    };
    const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, options) : dialog.showMessageBoxSync(options);
    return choice === 1;
  },
  stopBackend: () => manager.stop(),
  quit: () => app.quit(),
  onShutdownError: (err) => {
    console.error('[main] backend shutdown failed; quitting anyway:', err instanceof Error ? err.message : err);
  },
});

function isFromMainWindow(wc: Electron.WebContents | null): boolean {
  return wc !== null && mainWindow !== null && wc === mainWindow.webContents;
}

function hardenSession(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  // Microphone is core to the app; every other permission is denied. Media is
  // granted only for audio-only requests from the main frame of our own trusted
  // renderer (exact URL/origin); camera and screen pictures can never be granted.
  // System audio comes through getDisplayMedia, whose only grant is loopback
  // audio (displayMediaGrant). The authoritative grant is the request handler.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { requestingUrl?: string; mediaTypes?: string[]; isMainFrame?: boolean };
    const granted = isTrustedMediaRequest(
      {
        permission,
        fromTrustedWebContents: isFromMainWindow(wc) && d.isMainFrame !== false,
        requestingUrl: d.requestingUrl,
        mediaTypes: d.mediaTypes,
      },
      EXPECTED_RENDERER_URL,
    );
    callback(granted);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const d = (details ?? {}) as { isMainFrame?: boolean; mediaType?: string };
    return isTrustedMediaCheck(
      {
        permission,
        fromTrustedWebContents: isFromMainWindow(wc),
        requestingOrigin,
        isMainFrame: d.isMainFrame,
        mediaType: d.mediaType,
      },
      EXPECTED_RENDERER_ORIGIN,
    );
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    const grant = displayMediaGrant(
      {
        fromTrustedFrame: frame !== null && frame.parent === null && mainWindow !== null
          && frame === mainWindow.webContents.mainFrame,
        securityOrigin: request.securityOrigin,
        audioRequested: request.audioRequested,
        videoRequested: request.videoRequested,
      },
      EXPECTED_RENDERER_ORIGIN,
    );
    // An empty callback denies: the renderer's getDisplayMedia rejects.
    callback(grant ?? {});
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    icon: app.isPackaged ? undefined : APP_ICON,
    backgroundColor: '#ffffff',
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Block navigation away from the app and any new windows. Only hand safe
  // http/https links to the OS browser; never local/custom schemes from content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== EXPECTED_RENDERER_URL) event.preventDefault();
  });

  if (isDev && RENDERER_DEV_URL) {
    void mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    void mainWindow.loadFile(RENDERER_HTML);
  }

  // Guard against losing unsent audio: route close through the quit controller
  // so the same single dialog decides, and the backend is only stopped after the
  // user authorizes the quit.
  mainWindow.on('close', (event) => {
    if (quitController.onWindowClose()) event.preventDefault();
  });

  mainWindow.webContents.on('render-process-gone', () => { nativeClient?.abort(); rendererSave.disconnected(); });
  mainWindow.on('closed', () => {
    rendererSave.disconnected();
    nativeClient?.abort();
    mainWindow = null;
  });
}

/**
 * A copy started from the DMG or Downloads is a second SKAZ in Launchpad and
 * Spotlight. Offer to move it into /Applications before anything else runs;
 * on success Electron relaunches the moved copy and this process exits.
 */
function offerMoveToApplications(): boolean {
  const userData = app.getPath('userData');
  if (!shouldOfferMoveToApplications({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isInApplicationsFolder: app.isInApplicationsFolder(),
    declinedForever: readDeclinedForever(userData),
    customUserData: app.commandLine.hasSwitch('user-data-dir'),
  })) return false;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    message: 'Move SKAZ to the Applications folder?',
    detail: 'SKAZ is running from outside Applications, so macOS may show it twice in Launchpad. '
      + 'Moving it keeps a single SKAZ.',
    buttons: ['Move to Applications', 'Not Now', "Don't Ask Again"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 2) writeDeclinedForever(userData);
  if (choice !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (err) {
    dialog.showErrorBox('Could not move SKAZ', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// One SKAZ at a time: a second launch focuses the existing window instead of
// starting a second app and a second backend on the same data.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (offerMoveToApplications()) return;
  hardenSession();
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(APP_ICON);
  // macOS gates microphone access at the OS level, on top of Chromium's own
  // permission handler. Without this call TCC never shows its dialog, the
  // renderer's getUserMedia fails, and device labels stay empty so the picker
  // can only show "Microphone 1". Asking while already granted is a no-op.
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch((err: unknown) => {
      console.error('[main] microphone access request failed:', err instanceof Error ? err.message : err);
    });
  }
  nativeClient = registerIpc(manager, () => mainWindow?.webContents.id ?? null, (failure) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.nativeFailure, failure);
    }
  });
  ipcMain.on(CHANNELS.quitPrepared, (event, id: unknown, saved: unknown) => {
    if (!isTrustedFrame({
      senderId: event.sender.id,
      expectedId: mainWindow?.webContents.id ?? null,
      isMainFrame: event.senderFrame?.parent === null,
    })) return;
    rendererSave.acknowledge(id, saved);
  });
  ipcMain.on(CHANNELS.codexActivity, (event, payload: unknown) => {
    if (!isTrustedFrame({
      senderId: event.sender.id,
      expectedId: mainWindow?.webContents.id ?? null,
      isMainFrame: event.senderFrame?.parent === null,
    })) return;
    const count = validateCodexActivity(payload);
    if (count !== null) codexActiveTasks = count;
  });
  ipcMain.on(CHANNELS.captureState, (event, payload: unknown) => {
    const trusted = isTrustedFrame({
      senderId: event.sender.id,
      expectedId: mainWindow?.webContents.id ?? null,
      isMainFrame: event.senderFrame?.parent === null,
    });
    if (!trusted) return;
    const validated = validateCaptureState(payload);
    if (validated) captureState = validated;
  });
  createWindow();

  // Start the backend after the window exists so status events reach the UI.
  manager.start().catch((err) => {
    // Status is already set to 'error' inside the manager; log for the operator.
    console.error('[main] backend failed to start:', err instanceof Error ? err.message : err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitController.onBeforeQuit()) event.preventDefault();
});
