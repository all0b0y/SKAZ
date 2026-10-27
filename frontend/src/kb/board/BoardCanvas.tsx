import { useEffect, useState } from 'react';
import type { BoardSize, BoardTheme } from './BoardFrame';

/**
 * The canvas: frames side by side like a designer's board. Each frame is an iframe of the same page
 * (`#design-board/frame?theme=…&size=…`), because the themes and text sizes live on <html> and one
 * document can only have one of each.
 */

const THEMES: BoardTheme[] = ['light', 'dark'];
const SIZES: BoardSize[] = ['s', 'm', 'l'];
const ZOOMS = [0.5, 0.75, 1] as const;

export const frameHash = (theme: BoardTheme, size: BoardSize) => `#design-board/frame?theme=${theme}&size=${size}`;

export function BoardCanvas() {
  const [sizes, setSizes] = useState<BoardSize[]>(['m']);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(0.75);
  const [heights, setHeights] = useState<Record<string, number>>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const d = event.data as { kbBoard?: string; theme?: string; size?: string; height?: number };
      if (d?.kbBoard === 'height' && typeof d.height === 'number') setHeights((h) => ({ ...h, [`${d.theme}-${d.size}`]: d.height! }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const toggle = (s: BoardSize) => setSizes((now) => (now.includes(s) ? (now.length > 1 ? now.filter((x) => x !== s) : now) : SIZES.filter((x) => x === s || now.includes(x))));
  const base = window.location.href.split('#')[0];

  return (
    <div className="kb-canvas">
      <div className="kb-canvas__bar">
        <b>SKAZ · design board</b>
        <span>Text size</span>
        {SIZES.map((s) => <button key={s} type="button" aria-pressed={sizes.includes(s)} onClick={() => toggle(s)}>{s.toUpperCase()}</button>)}
        <span>Zoom</span>
        {ZOOMS.map((z) => <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>{Math.round(z * 100)}%</button>)}
      </div>
      <div className="kb-canvas__grid" style={{ zoom }}>
        {sizes.map((size) => THEMES.map((theme) => (
          <figure key={`${theme}-${size}`} className="kb-canvas__frame">
            <figcaption>{theme === 'light' ? 'Light' : 'Dark'} · text {size.toUpperCase()}</figcaption>
            <iframe title={`${theme} ${size}`} src={`${base}${frameHash(theme, size)}`} style={{ height: heights[`${theme}-${size}`] ?? 1200 }} />
          </figure>
        )))}
      </div>
    </div>
  );
}
