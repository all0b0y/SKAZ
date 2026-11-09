import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstCloseHint, readTrayPrefs, trayMenuTemplate, TrayBehavior, trayPrefsStore, writeTrayPrefs, type TrayPrefs } from './trayBehavior';
import { hasUnsentAudio, captureStatusLine } from './captureProtection';

function behavior(initial: Partial<TrayPrefs> = {}, overrides: { trayAvailable?: boolean; showHint?: () => boolean; writeOk?: boolean } = {}) {
  const prefs: TrayPrefs = { closeQuits: false, hintShown: false, ...initial };
  const hide = vi.fn();
  const showHint = vi.fn(overrides.showHint ?? (() => true));
  const write = vi.fn((next: TrayPrefs) => {
    if (overrides.writeOk === false) return false;
    Object.assign(prefs, next);
    return true;
  });
  const tray = new TrayBehavior({
    prefs: { read: () => ({ ...prefs }), write },
    trayAvailable: () => overrides.trayAvailable ?? true,
    hide,
    showHint,
  });
  return { tray, hide, showHint, write, prefs };
}

describe('TrayBehavior — closing the window', () => {
  it('default: takes the close and hides', () => {
    const f = behavior();
    expect(f.tray.onWindowClose()).toBe(true);
    expect(f.hide).toHaveBeenCalledTimes(1);
  });

  it('toggle on: does not take the close', () => {
    const f = behavior({ closeQuits: true });
    expect(f.tray.onWindowClose()).toBe(false);
    expect(f.hide).not.toHaveBeenCalled();
    expect(f.showHint).not.toHaveBeenCalled();
  });

  it('no tray icon could be made: closing quits, so SKAZ can never be left running with no way back', () => {
    const f = behavior({}, { trayAvailable: false });
    expect(f.tray.onWindowClose()).toBe(false);
    expect(f.hide).not.toHaveBeenCalled();
  });

  it('the OS is ending the session (Windows sends no before-quit then): closing must not hide', () => {
    const f = behavior();
    f.tray.onSessionEnd();
    expect(f.tray.onWindowClose()).toBe(false);
    expect(f.hide).not.toHaveBeenCalled();
  });
});

describe('TrayBehavior — the first-close hint', () => {
  it('shows once, on the first close only, and after the window has been hidden', () => {
    const f = behavior();
    f.tray.onWindowClose();
    f.tray.onWindowClose();
    f.tray.onWindowClose();
    expect(f.hide).toHaveBeenCalledTimes(3);
    expect(f.showHint).toHaveBeenCalledTimes(1);
    expect(f.hide.mock.invocationCallOrder[0]).toBeLessThan(f.showHint.mock.invocationCallOrder[0]!);
    expect(f.prefs.hintShown).toBe(true);
  });

  it('stays once across restarts: a hint seen earlier is not shown again', () => {
    const f = behavior({ hintShown: true });
    f.tray.onWindowClose();
    expect(f.showHint).not.toHaveBeenCalled();
  });

  it('a hint that could not be shown (notifications unsupported) is kept for a later close', () => {
    let supported = false;
    const f = behavior({}, { showHint: () => supported });
    f.tray.onWindowClose();
    expect(f.prefs.hintShown).toBe(false);
    supported = true;
    f.tray.onWindowClose();
    f.tray.onWindowClose();
    expect(f.showHint).toHaveBeenCalledTimes(2);
    expect(f.prefs.hintShown).toBe(true);
  });

  it('a throwing notification never breaks the close', () => {
    const f = behavior({}, { showHint: () => { throw new Error('no notification service'); } });
    expect(f.tray.onWindowClose()).toBe(true);
    expect(f.hide).toHaveBeenCalledTimes(1);
  });

  it('an unwritable profile shows the hint once per run, not on every close', () => {
    const f = behavior({}, { writeOk: false });
    f.tray.onWindowClose();
    f.tray.onWindowClose();
    expect(f.showHint).toHaveBeenCalledTimes(1);
  });

  it('turning the toggle on and off keeps the hint state', () => {
    const f = behavior({ hintShown: true });
    f.tray.setCloseQuits(true);
    f.tray.setCloseQuits(false);
    expect(f.prefs.hintShown).toBe(true);
  });
});

describe('TrayBehavior — the setting', () => {
  it('is off by default and takes effect on the next close', () => {
    const f = behavior();
    expect(f.tray.closeQuits).toBe(false);
    expect(f.tray.setCloseQuits(true)).toBe(true);
    expect(f.tray.closeQuits).toBe(true);
    expect(f.tray.onWindowClose()).toBe(false);
    expect(f.tray.setCloseQuits(false)).toBe(false);
    expect(f.tray.onWindowClose()).toBe(true);
  });

  it('a failed save changes nothing and reports the state that is really in force', () => {
    const f = behavior({}, { writeOk: false });
    expect(f.tray.setCloseQuits(true)).toBe(false);
    expect(f.tray.closeQuits).toBe(false);
    expect(f.tray.onWindowClose()).toBe(true);
  });
});

describe('tray prefs on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skaz-tray-prefs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('defaults when the file is missing, broken or the wrong shape', () => {
    const defaults = { closeQuits: false, hintShown: false };
    expect(readTrayPrefs(dir)).toEqual(defaults);
    writeFileSync(join(dir, 'tray.json'), '{not json');
    expect(readTrayPrefs(dir)).toEqual(defaults);
    writeFileSync(join(dir, 'tray.json'), JSON.stringify([1]));
    expect(readTrayPrefs(dir)).toEqual(defaults);
    writeFileSync(join(dir, 'tray.json'), JSON.stringify({ closeQuits: 'yes', hintShown: 1 }));
    expect(readTrayPrefs(dir)).toEqual(defaults);
  });

  it('round-trips and survives a restart', () => {
    expect(writeTrayPrefs(dir, { closeQuits: true, hintShown: true })).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'tray.json'), 'utf8'))).toEqual({ closeQuits: true, hintShown: true });
    const store = trayPrefsStore(dir);
    expect(store.read()).toEqual({ closeQuits: true, hintShown: true });
  });

  it('reports a failed write instead of throwing', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    expect(writeTrayPrefs(join(file, 'not-a-directory'), { closeQuits: true, hintShown: false })).toBe(false);
  });
});

describe('tray menu', () => {
  it('is Open SKAZ, the status line (not clickable), Quit', () => {
    const open = vi.fn();
    const quit = vi.fn();
    const items = trayMenuTemplate('Idle', { open, quit });
    expect(items.map((i) => ('label' in i ? i.label : '-'))).toEqual(['Open SKAZ', 'Idle', '-', 'Quit']);
    const [openItem, status, , quitItem] = items as [{ click: () => void }, { enabled: boolean; click?: unknown }, unknown, { click: () => void }];
    expect(status.enabled).toBe(false);
    expect(status.click).toBeUndefined();
    openItem.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    quitItem.click();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('first-close hint wording', () => {
  it('says menu bar on macOS and tray elsewhere', () => {
    expect(firstCloseHint('darwin').title).toBe('SKAZ is still running in the menu bar');
    expect(firstCloseHint('win32').title).toBe('SKAZ is still running in the tray');
    expect(firstCloseHint('linux').title).toBe('SKAZ is still running in the tray');
    expect(firstCloseHint('darwin').body).toMatch(/menu bar/);
    expect(firstCloseHint('win32').body).not.toMatch(/menu bar/);
  });
});

describe('the capture status line of the tray', () => {
  const state = (recorderState: 'idle' | 'recording' | 'paused' | 'processing' | 'stopped', pending = 0, failed = 0) => ({ recorderState, pending, failed });

  it('never claims Idle while audio is at risk', () => {
    const states = [state('recording'), state('processing'), state('idle', 2), state('stopped', 0, 1), state('recording', 3, 1)];
    for (const s of states) {
      expect(hasUnsentAudio(s)).toBe(true);
      expect(captureStatusLine(s)).not.toBeNull();
    }
  });

  it('names each situation, worst first, and is silent when nothing is going on', () => {
    expect(captureStatusLine(state('recording'))).toBe('Recording');
    expect(captureStatusLine(state('paused'))).toBe('Recording paused');
    expect(captureStatusLine(state('processing'))).toBe('Saving audio');
    expect(captureStatusLine(state('idle', 2))).toBe('Saving audio');
    expect(captureStatusLine(state('recording', 3, 1))).toBe('Some audio couldn’t be saved');
    expect(captureStatusLine(state('idle'))).toBeNull();
    expect(captureStatusLine(state('stopped'))).toBeNull();
  });
});
