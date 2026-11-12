// EX3 (UX-1a): wires the paper reader (paperViewPolicy.ts) to Electron — one WebContentsView over the slot
// the Explore page keeps for it. Its page is a site, not SKAZ: no preload, no IPC, sandboxed, own session.
// Publishers that refuse iframes (arXiv abs, DOI landing pages) open here, since this is a view of its own.

import { ipcMain, session, shell, WebContentsView, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { CHANNELS } from './channels';
import {
  EMPTY_PAPER_STATE,
  isPaperNavigation,
  PAPER_PARTITION,
  paperLoadError,
  paperPermissionAllowed,
  paperPopupTarget,
  validatePaperBounds,
  validatePaperUrl,
  type PaperViewState,
} from './paperViewPolicy';

let hardened = false;

function hardenPaperSession(): void {
  if (hardened) return;
  hardened = true;
  const papers = session.fromPartition(PAPER_PARTITION);
  papers.setPermissionRequestHandler((_wc, permission, callback) => callback(paperPermissionAllowed(permission)));
  papers.setPermissionCheckHandler((_wc, permission) => paperPermissionAllowed(permission));
  // A paper reaches SKAZ only through «Add to materials»: the reader saves nothing to disk.
  papers.on('will-download', (event) => event.preventDefault());
}

export class PaperReader {
  private view: WebContentsView | null = null;
  private state: PaperViewState = EMPTY_PAPER_STATE;

  constructor(private readonly window: () => BrowserWindow | null) {}

  show(rawUrl: unknown, rawBounds: unknown): boolean {
    const url = validatePaperUrl(rawUrl);
    const win = this.window();
    if (!url || !win || win.isDestroyed()) return false;
    const view = this.ensure(win);
    if (!this.place(rawBounds)) view.setVisible(false);
    else view.setVisible(true);
    if (view.webContents.getURL() !== url) void view.webContents.loadURL(url).catch(() => undefined);
    return true;
  }

  bounds(rawBounds: unknown): boolean {
    return this.place(rawBounds);
  }

  hide(): void {
    this.view?.setVisible(false);
  }

  navigate(action: unknown): boolean {
    const view = this.view;
    if (!view || !isPaperNavigation(action)) return false;
    const history = view.webContents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') view.webContents.reload();
    else if (action === 'external') {
      const url = validatePaperUrl(view.webContents.getURL());
      if (url) void shell.openExternal(url);
      return url !== null;
    }
    return true;
  }

  /** The SKAZ window is gone: the reader goes with it (its session, and so its logins, stay). */
  destroy(): void {
    const view = this.view;
    this.view = null;
    this.state = EMPTY_PAPER_STATE;
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }

  private place(rawBounds: unknown): boolean {
    const win = this.window();
    const view = this.view;
    if (!win || win.isDestroyed() || !view) return false;
    const [width = 0, height = 0] = win.getContentSize();
    const rect = validatePaperBounds(rawBounds, { width, height }, win.webContents.getZoomFactor());
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    view.setBounds(rect);
    return true;
  }

  private ensure(win: BrowserWindow): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    hardenPaperSession();
    const view = new WebContentsView({
      webPreferences: {
        partition: PAPER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // Chromium's PDF viewer: an open PDF reads in place instead of being downloaded.
        plugins: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      const target = paperPopupTarget(url);
      if (target) void contents.loadURL(target).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!validatePaperUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!validatePaperUrl(url)) event.preventDefault();
    });
    const report = (patch: Partial<PaperViewState>): void => {
      const history = contents.navigationHistory;
      this.state = {
        ...this.state,
        url: validatePaperUrl(contents.getURL()),
        title: contents.getTitle(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
        ...patch,
      };
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.paperState, this.state);
      }
    };
    contents.on('did-start-loading', () => report({ loading: true, error: null }));
    contents.on('did-stop-loading', () => report({ loading: false }));
    contents.on('page-title-updated', () => report({}));
    contents.on('did-navigate', () => report({}));
    contents.on('did-navigate-in-page', () => report({}));
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      const error = paperLoadError(code, description);
      if (error) report({ loading: false, error });
    });
    win.contentView.addChildView(view);
    this.view = view;
    return view;
  }
}

/** Explore's reader slot: show a paper, follow the slot as the page lays out, hide it, step back and forth. */
export function registerPaperReaderIpc(reader: PaperReader, trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(CHANNELS.paperShow, (event, url: unknown, bounds: unknown) => trusted(event) && reader.show(url, bounds));
  ipcMain.handle(CHANNELS.paperBounds, (event, bounds: unknown) => trusted(event) && reader.bounds(bounds));
  ipcMain.handle(CHANNELS.paperHide, (event) => {
    if (trusted(event)) reader.hide();
    return true;
  });
  ipcMain.handle(CHANNELS.paperNavigate, (event, action: unknown) => trusted(event) && reader.navigate(action));
}
