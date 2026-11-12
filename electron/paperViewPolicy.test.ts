import { describe, expect, it } from 'vitest';
import {
  isPaperNavigation,
  PAPER_PARTITION,
  paperLoadError,
  paperPermissionAllowed,
  paperPopupTarget,
  validatePaperBounds,
  validatePaperUrl,
} from './paperViewPolicy';

describe('paper reader policy (EX3)', () => {
  it('opens only http(s) pages without credentials', () => {
    expect(validatePaperUrl('https://arxiv.org/html/2401.04088')).toBe('https://arxiv.org/html/2401.04088');
    expect(validatePaperUrl('http://example.org/a.pdf')).toBe('http://example.org/a.pdf');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'skaz://x', 'https://u:p@example.org/', '', 42, null]) {
      expect(validatePaperUrl(bad)).toBeNull();
    }
    expect(validatePaperUrl('https://example.org/' + 'a'.repeat(5000))).toBeNull();
  });

  it('keeps its own persistent session apart from SKAZ', () => {
    expect(PAPER_PARTITION.startsWith('persist:')).toBe(true);
    expect(PAPER_PARTITION).not.toBe('');
  });

  it('turns the slot into window pixels inside the window', () => {
    const win = { width: 1280, height: 820 };
    expect(validatePaperBounds({ x: 600.4, y: 120, width: 640, height: 600 }, win)).toEqual({ x: 600, y: 120, width: 640, height: 600 });
    expect(validatePaperBounds({ x: 600, y: 100, width: 640, height: 600 }, win, 1.25)).toEqual({ x: 750, y: 125, width: 530, height: 695 });
    expect(validatePaperBounds({ x: -20, y: 0, width: 100, height: 50 }, win)).toEqual({ x: 0, y: 0, width: 80, height: 50 });
    expect(validatePaperBounds({ x: 0, y: 0, width: Number.NaN, height: 1 }, win)).toBeNull();
    expect(validatePaperBounds('0,0,1,1', win)).toBeNull();
    expect(validatePaperBounds({ x: 0, y: 0, width: 10 }, win)).toBeNull();
  });

  it('denies every permission but copying and full screen', () => {
    expect(paperPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect(paperPermissionAllowed('fullscreen')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'midi']) {
      expect(paperPermissionAllowed(p)).toBe(false);
    }
  });

  it('follows http(s) popups in place and accepts only known navigation', () => {
    expect(paperPopupTarget('https://doi.org/10.1/x')).toBe('https://doi.org/10.1/x');
    expect(paperPopupTarget('mailto:a@b.c')).toBeNull();
    expect(['back', 'forward', 'reload', 'external'].every(isPaperNavigation)).toBe(true);
    expect(isPaperNavigation('download')).toBe(false);
  });

  it('does not report a load replaced by a newer one', () => {
    expect(paperLoadError(-3, 'ERR_ABORTED')).toBeNull();
    expect(paperLoadError(-105, 'ERR_NAME_NOT_RESOLVED')).toBe('ERR_NAME_NOT_RESOLVED');
  });
});
