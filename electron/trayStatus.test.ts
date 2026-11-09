import { describe, expect, it, vi } from 'vitest';
import { TrayStatus, TRAY_IDLE } from './trayStatus';

describe('TrayStatus — what other slices feed the tray menu with', () => {
  it('says Idle when nobody reports anything', () => {
    expect(new TrayStatus().current()).toBe(TRAY_IDLE);
    expect(TRAY_IDLE).toBe('Idle');
  });

  it('shows the most recent report; clearing it reveals the one before, then Idle', () => {
    const status = new TrayStatus();
    status.set('check', 'Checking the library');
    status.set('research', 'Research task running');
    expect(status.current()).toBe('Research task running');
    status.set('research', null);
    expect(status.current()).toBe('Checking the library');
    status.set('check', null);
    expect(status.current()).toBe(TRAY_IDLE);
  });

  it('an updated source becomes the most recent one', () => {
    const status = new TrayStatus();
    status.set('check', 'Checking 1 of 5');
    status.set('research', 'Research task running');
    status.set('check', 'Checking 2 of 5');
    expect(status.current()).toBe('Checking 2 of 5');
  });

  it('tells subscribers only when the line really changed; unsubscribing stops it', () => {
    const status = new TrayStatus();
    const listener = vi.fn();
    const off = status.subscribe(listener);
    status.set('check', 'Checking');
    status.set('check', 'Checking');
    status.set('other', null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith('Checking');
    status.set('check', null);
    expect(listener).toHaveBeenLastCalledWith(TRAY_IDLE);
    off();
    status.set('check', 'Again');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a throwing subscriber does not break the reporter or the other subscribers', () => {
    const status = new TrayStatus();
    const other = vi.fn();
    status.subscribe(() => { throw new Error('menu gone'); });
    status.subscribe(other);
    expect(() => status.set('check', 'Checking')).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('keeps the line to one short line; blank text counts as cleared', () => {
    const status = new TrayStatus();
    status.set('check', '  Checking\n\tlinks  ');
    expect(status.current()).toBe('Checking links');
    status.set('check', 'x'.repeat(200));
    expect(status.current().length).toBeLessThanOrEqual(60);
    expect(status.current().endsWith('…')).toBe(true);
    status.set('check', '   ');
    expect(status.current()).toBe(TRAY_IDLE);
  });
});
