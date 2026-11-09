// Wires the tray (trayBehavior.ts, trayStatus.ts) to Electron: the icon and its menu, the first-close hint and
// the IPC of the Settings row. Started by main.ts.

import { ipcMain, Menu, nativeImage, Notification, Tray, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { CHANNELS } from './channels';
import { firstCloseHint, trayMenuTemplate, type TrayBehavior } from './trayBehavior';
import { trayIconSet } from './trayIcons';
import type { TrayStatus } from './trayStatus';

function trayImage(platform: NodeJS.Platform): NativeImage {
  const set = trayIconSet(platform);
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(set.x1, 'base64') });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(set.x2, 'base64') });
  if (set.template) image.setTemplateImage(true);
  return image;
}

/** The tray icon, or null if this system won't give one: then closing the window simply quits. */
export function startTray(status: TrayStatus, actions: { open: () => void; quit: () => void }): Tray | null {
  try {
    const tray = new Tray(trayImage(process.platform));
    tray.setToolTip('SKAZ');
    const showStatus = (line: string): void => {
      if (!tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(line, actions))); // reports can outlive it at quit
    };
    showStatus(status.current());
    status.subscribe(showStatus);
    // A left click on Windows and Linux. On macOS the menu takes the click and this never fires.
    tray.on('click', () => actions.open());
    return tray;
  } catch (err) {
    console.error('[main] tray unavailable; closing the window will quit:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Held so a click on the shown notification still reaches its handler after a garbage collection.
let hint: Notification | null = null;

/** The one-time "SKAZ is still running" hint. False when this system has no notifications. */
export function showFirstCloseHint(open: () => void): boolean {
  if (!Notification.isSupported()) return false;
  hint = new Notification(firstCloseHint(process.platform));
  hint.on('click', () => open());
  hint.show();
  return true;
}

/** Settings → "Closing the window quits SKAZ". */
export function registerCloseQuitsIpc(behavior: TrayBehavior, trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(CHANNELS.closeQuitsGet, (event) => (trusted(event) ? behavior.closeQuits : false));
  ipcMain.handle(CHANNELS.closeQuitsSet, (event, on: unknown) => {
    if (!trusted(event) || typeof on !== 'boolean') return behavior.closeQuits;
    return behavior.setCloseQuits(on);
  });
}
