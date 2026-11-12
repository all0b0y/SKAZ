import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, session, shell, systemPreferences, type Tray } from 'electron';
import path from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { migrateLegacyProfile, resolveStorageProfile } from './storageProfile';
import { fileURLToPath } from 'node:url';
import { BackendManager } from './backend';
import { registerIpc } from './ipc';
import type { NativeLiveClient } from './nativeLive';
import { CHANNELS } from './channels';
import { isAllowedExternalUrl } from './ipcPolicy';
import { captureStatusLine, hasUnsentAudio, quitWarning, type CaptureProtectionState } from './captureProtection';
import { displayMediaGrant, isTrustedMediaCheck, isTrustedMediaRequest } from './permissionPolicy';
import { isTrustedFrame, validateCaptureState } from './ipcSender';
import { QuitController } from './quitController';
import { RendererSaveBarrier } from './rendererSaveBarrier';
import { readDeclinedForever, shouldOfferMoveToApplications, writeDeclinedForever } from './installLocation';
import { registerUpdates } from './updateRuntime';
import { TrayBehavior, trayPrefsStore } from './trayBehavior';
import { registerCloseQuitsIpc, showFirstCloseHint, startTray } from './trayRuntime';
import { PaperReader, registerPaperReaderIpc } from './paperViewRuntime';
import { trayStatus } from './trayStatus';
import { BackgroundJobs } from './backgroundJobs';
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
// compiled Icon Composer asset, and the repo-relative PNG does not exist inside it.
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
const paperReader = new PaperReader(() => mainWindow);
let nativeClient: NativeLiveClient | null = null;
// Module-level so it is never garbage collected: a collected Tray disappears from the menu bar.
let tray: Tray | null = null;
let backgroundJobs: BackgroundJobs | null = null;
// The window was closed into the tray. Tells a hidden window from one that hasn't appeared yet at launch.
let hiddenToTray = false;

// Resolve every persistent path before the backend, singleton or Chromium session
// is constructed. Packaged builds ignore development profile flags/env entirely.
const PROFILE = resolveStorageProfile({
  home: app.getPath('home'), documents: app.getPath('documents'),
  packaged: app.isPackaged, requested: process.env.SKAZ_PROFILE,
});
const smokePath = !app.isPackaged ? process.env.SKAZ_OPTIN_SMOKE_USER_DATA : undefined;
const customPath = app.commandLine.getSwitchValue('user-data-dir');
if (smokePath) {
  if (realpathSync(app.getPath('userData')) !== realpathSync(smokePath)) {
    throw new Error('Smoke profile was not isolated by the launch wrapper.');
  }
} else {
  const userData = customPath ? path.resolve(customPath) : PROFILE.userData;
  if (!customPath && PROFILE.name === 'default') migrateLegacyProfile(app.getPath('home'), userData);
  const documents = customPath ? path.join(userData, 'Documents') : PROFILE.documents;
  for (const directory of [userData, documents]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setPath('documents', documents);
}
app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
const crashDirectory = path.join(app.getPath('userData'), 'crashes');
mkdirSync(crashDirectory, { recursive: true, mode: 0o700 });
app.setPath('crashDumps', crashDirectory);
const DATA_DIR = path.join(app.getPath('userData'), 'data');

// Latest capture snapshot reported by the renderer (validated). Consulted on
// close/quit so unsent audio is never dropped without a warning.
let captureState: CaptureProtectionState = { recorderState: 'idle', pending: 0, failed: 0 };

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

/** Bring the window back from anywhere: the tray, a minimized state, behind other windows. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  hiddenToTray = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  hiddenToTray = true;
  // Hiding a full screen window on macOS leaves its empty black Space behind: leave full screen first.
  if (win.isFullScreen()) {
    win.once('leave-full-screen', () => { if (hiddenToTray && !win.isDestroyed()) win.hide(); });
    win.setFullScreen(false);
  } else {
    win.hide();
  }
}

/** Open SKAZ, from the tray or the hint: during a shutdown it counts as a launch, like a Dock click. */
function openFromTray(): void {
  if (quitController.onLaunchRequest()) return;
  showMainWindow();
  app.focus({ steal: true }); // the user asked for it in the tray: it must not open behind other apps
}

const trayBehavior = new TrayBehavior({
  prefs: trayPrefsStore(app.getPath('userData')),
  trayAvailable: () => tray !== null,
  hide: hideMainWindowToTray,
  showHint: () => showFirstCloseHint(openFromTray),
  defer: (run) => { setTimeout(run, 300); },
});

const quitController = new QuitController({
  saveBeforeQuit: () => mainWindow ? rendererSave.request() : Promise.resolve(!hasUnsentAudio(captureState)),
  hasUnsentAudio: () => hasUnsentAudio(captureState),
  confirmDiscard: () => {
    // Each situation in its own words: still saving, couldn't save, or the end unconfirmed.
    const warning = quitWarning(captureState);
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: warning.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: warning.message,
      detail: warning.detail,
    };
    // Never a sheet on a hidden window: it would block this process with nothing on the screen.
    const choice = mainWindow?.isVisible() ? dialog.showMessageBoxSync(mainWindow, options) : dialog.showMessageBoxSync(options);
    return choice === 1;
  },
  stopBackend: () => manager.stop(),
  quit: () => app.quit(),
  hideWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); },
  showWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) showMainWindow(); },
  relaunch: () => app.relaunch(),
  closeToTray: () => trayBehavior.onWindowClose(),
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

/** Tell the page whether its window is in full screen (no traffic lights then), now and on every change. */
function reportFullScreen(win: BrowserWindow): void {
  const send = (): void => { if (!win.webContents.isDestroyed()) win.webContents.send(CHANNELS.fullScreen, win.isFullScreen()); };
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
  win.webContents.on('did-finish-load', send);
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
  reportFullScreen(mainWindow);

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

  // One authority for closing: by default the quit controller only hides the window into the tray; when
  // closing quits, the same single dialog guards unsent audio, and the backend is only stopped after the user
  // authorizes the quit.
  mainWindow.on('close', (event) => {
    if (quitController.onWindowClose()) event.preventDefault();
  });
  mainWindow.on('show', () => { hiddenToTray = false; }); // whoever showed it (e.g. the update notification)
  mainWindow.on('session-end', () => trayBehavior.onSessionEnd());

  mainWindow.webContents.on('render-process-gone', () => { nativeClient?.abort(); rendererSave.disconnected(); });
  mainWindow.on('closed', () => {
    paperReader.destroy();
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
    // A macOS-only API: elsewhere it does not exist (and nothing is offered there).
    isInApplicationsFolder: process.platform === 'darwin' && app.isInApplicationsFolder(),
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
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (quitController.onLaunchRequest()) return; // shutting down: relaunch once this process has exited
    if (!mainWindow) return;
    showMainWindow();
  });
}

app.whenReady().then(() => {
  if (!ownsInstance || offerMoveToApplications()) return;
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
  ipcMain.on(CHANNELS.captureState, (event, payload: unknown) => {
    const trusted = isTrustedFrame({
      senderId: event.sender.id,
      expectedId: mainWindow?.webContents.id ?? null,
      isMainFrame: event.senderFrame?.parent === null,
    });
    if (!trusted) return;
    const validated = validateCaptureState(payload);
    if (validated) {
      captureState = validated;
      trayStatus.set('capture', captureStatusLine(validated));
    }
  });
  // Updates (B20): GitHub Releases at start and daily; the About row reads and drives it.
  registerUpdates(() => mainWindow, (event) => isTrustedFrame({
    senderId: event.sender.id,
    expectedId: mainWindow?.webContents.id ?? null,
    isMainFrame: event.senderFrame?.parent === null,
  }));
  registerCloseQuitsIpc(trayBehavior, (event) => isTrustedFrame({
    senderId: event.sender.id,
    expectedId: mainWindow?.webContents.id ?? null,
    isMainFrame: event.senderFrame?.parent === null,
  }));
  registerPaperReaderIpc(paperReader, (event) => isTrustedFrame({
    senderId: event.sender.id,
    expectedId: mainWindow?.webContents.id ?? null,
    isMainFrame: event.senderFrame?.parent === null,
  }));
  tray = startTray(trayStatus, { open: openFromTray, quit: () => app.quit() });
  // 0.4.0: a running background job (weekly check, Check links, Explore, research) keeps SKAZ from being
  // suspended with the window hidden, and the tray names its kind.
  backgroundJobs = new BackgroundJobs({
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
    blocker: { start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => powerSaveBlocker.stop(id) },
    tray: trayStatus,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  backgroundJobs.start();
  createWindow();

  // Start the backend after the window exists so status events reach the UI.
  manager.start().catch((err) => {
    // Status is already set to 'error' inside the manager; log for the operator.
    console.error('[main] backend failed to start:', err instanceof Error ? err.message : err);
  });

  app.on('activate', () => {
    // A Dock click while the hidden window is still shutting down reaches THIS process on macOS.
    if (quitController.onLaunchRequest()) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (hiddenToTray) showMainWindow(); // a Dock click brings the window back from the tray
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitController.onBeforeQuit()) event.preventDefault();
});

app.on('will-quit', () => {
  backgroundJobs?.stop();
  // Windows would otherwise leave a dead icon in the tray until the pointer passes over it.
  tray?.destroy();
  tray = null;
});
