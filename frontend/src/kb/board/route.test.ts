import { describe, expect, it } from 'vitest';
import { memoryStorage } from './live';
import {
  applyLook, canvasHash, frameHash, parseBoardRoute, patternHash, screenHash, SCREEN_SIZES, type BoardLook,
} from './route';

const LOOK: BoardLook = { theme: 'dark', size: 'l', base: 'sand', accent: 'plum', density: 'compact' };

describe('board routes (layers 3–4)', () => {
  it('reads the canvas layer, 1 by default', () => {
    expect(parseBoardRoute('#design-board')).toEqual({ kind: 'canvas', layer: 1 });
    expect(parseBoardRoute('#design-board?layer=3')).toEqual({ kind: 'canvas', layer: 3 });
    expect(parseBoardRoute('#design-board?layer=4')).toEqual({ kind: 'canvas', layer: 4 });
    expect(parseBoardRoute('#design-board?layer=2')).toEqual({ kind: 'canvas', layer: 1 });
  });

  it('reads a pattern frame with its whole look', () => {
    expect(parseBoardRoute('#design-board/pattern?id=chat-rows&theme=dark&size=l&base=sand&accent=plum&density=compact'))
      .toEqual({ kind: 'pattern', id: 'chat-rows', ...LOOK });
  });

  it('reads a screen at one of the three widths, the height follows the width', () => {
    expect(parseBoardRoute('#design-board/screen?id=chat&w=1024&theme=dark&base=milk&accent=ink&density=spacious'))
      .toEqual({ kind: 'screen', id: 'chat', w: 1024, h: 768, theme: 'dark', size: 'm', base: 'milk', accent: 'ink', density: 'spacious' });
    expect(parseBoardRoute('#design-board/screen?id=chat&w=820')).toMatchObject({ w: 820, h: 700 });
    // An unknown width is the widest window, not a size nobody designed for.
    expect(parseBoardRoute('#design-board/screen?id=chat&w=999')).toMatchObject({ w: 1440, h: 900 });
  });

  it('drops values that are not knobs of the app and ids that are not registry ids', () => {
    expect(parseBoardRoute('#design-board/pattern?id=<img>&theme=x&base=lilac&accent=red&density=huge')).toEqual({
      kind: 'pattern', id: '', theme: 'light', size: 'm', base: 'milk', accent: 'ink', density: 'comfortable',
    });
    expect(parseBoardRoute('#design-board/screen?id=Chat_1')).toMatchObject({ id: '' });
  });

  it('builds hashes that read back to the same route', () => {
    expect(parseBoardRoute(frameHash(LOOK))).toEqual({ kind: 'frame', ...LOOK });
    expect(parseBoardRoute(patternHash('toast', LOOK))).toEqual({ kind: 'pattern', id: 'toast', ...LOOK });
    for (const { w, h } of SCREEN_SIZES) {
      expect(parseBoardRoute(screenHash('materials', w, LOOK))).toEqual({ kind: 'screen', id: 'materials', w, h, ...LOOK });
    }
    expect(parseBoardRoute(canvasHash(4))).toEqual({ kind: 'canvas', layer: 4 });
    expect(canvasHash(1)).toBe('#design-board');
  });

  it('puts the look on <html> the way ThemeSync does', () => {
    const html = document.createElement('html');
    applyLook(html, LOOK);
    expect({ ...html.dataset }).toEqual({ kbUi: '', theme: 'dark', textSize: 'l', base: 'sand', accent: 'plum', density: 'compact' });
  });
});

describe('memory storage of a frame', () => {
  it('keeps what is set, per instance', () => {
    const a = memoryStorage({ k: 'v' });
    const b = memoryStorage();
    a.setItem('x', '1');
    expect(a.getItem('k')).toBe('v');
    expect(a.getItem('x')).toBe('1');
    expect(a.length).toBe(2);
    expect(b.getItem('x')).toBeNull();
    a.removeItem('k');
    expect(a.key(0)).toBe('x');
    a.clear();
    expect(a.length).toBe(0);
  });
});
