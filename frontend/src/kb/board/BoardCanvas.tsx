import { useEffect, useState } from 'react';
import { ACCENTS, BASES, DENSITIES, type AccentPref, type BasePref, type DensityPref } from '../state/appearance';
import { PATTERNS } from './patterns';
import {
  canvasHash, frameHash, patternHash, screenHash, SCREEN_SIZES, SIZES, THEMES,
  type BoardLayer, type BoardLook, type BoardSize, type ScreenWidth,
} from './route';
import { SCREENS } from './screens';

/**
 * The canvas: frames side by side like a designer's board. Each frame is an iframe of the same page
 * (`#design-board/frame|pattern|screen?…`), because the theme, text size and look live on <html>
 * and one document can only have one of each. Layers: 1–2 (foundations, primitives), 3 (product
 * patterns), 4 (whole screens, a grid «screen × width», both themes).
 */

const ZOOMS: Record<BoardLayer, readonly number[]> = { 1: [0.5, 0.75, 1], 3: [0.5, 0.75, 1], 4: [0.25, 0.35, 0.5] };
const LAYERS: ReadonlyArray<{ id: BoardLayer; label: string }> = [
  { id: 1, label: '1–2 Foundations · Primitives' }, { id: 3, label: '3 Patterns' }, { id: 4, label: '4 Screens' },
];

function toggled<T>(all: readonly T[], now: readonly T[], v: T): T[] {
  if (now.includes(v)) return now.length > 1 ? now.filter((x) => x !== v) : [...now];
  return all.filter((x) => x === v || now.includes(x));
}

export function BoardCanvas({ initialLayer = 1 }: { initialLayer?: BoardLayer }) {
  const [layer, setLayer] = useState<BoardLayer>(initialLayer);
  const [sizes, setSizes] = useState<BoardSize[]>(['m']);
  const [widths, setWidths] = useState<ScreenWidth[]>(SCREEN_SIZES.map((s) => s.w));
  const [zooms, setZooms] = useState<Record<BoardLayer, number>>({ 1: 0.75, 3: 0.75, 4: 0.25 });
  const [base, setBase] = useState<BasePref>('milk');
  const [accent, setAccent] = useState<AccentPref>('ink');
  const [density, setDensity] = useState<DensityPref>('comfortable');
  const [heights, setHeights] = useState<Record<string, number>>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const d = event.data as { kbBoard?: string; key?: string; theme?: string; size?: string; height?: number };
      // Layers 1–2 say theme + size; patterns say their own key.
      if (d?.kbBoard === 'height' && typeof d.height === 'number') setHeights((h) => ({ ...h, [d.key ?? `${d.theme}-${d.size}`]: d.height! }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => { window.history.replaceState(null, '', canvasHash(layer)); }, [layer]);

  const origin = window.location.href.split('#')[0];
  const look = (theme: BoardLook['theme'], size: BoardSize): BoardLook => ({ theme, size, base, accent, density });
  const zoom = zooms[layer];

  return (
    <div className="kb-canvas" data-layer={layer}>
      <div className="kb-canvas__bar">
        <b>SKAZ · design board</b>
        {LAYERS.map((l) => <button key={l.id} type="button" className="kb-canvas__layer" aria-pressed={layer === l.id} onClick={() => setLayer(l.id)}>{l.label}</button>)}
        {layer === 4 ? (
          <>
            <span>Width</span>
            {SCREEN_SIZES.map(({ w }) => <button key={w} type="button" aria-pressed={widths.includes(w)} onClick={() => setWidths((now) => toggled(SCREEN_SIZES.map((s) => s.w), now, w))}>{w}</button>)}
          </>
        ) : (
          <>
            <span>Text size</span>
            {SIZES.map((s) => <button key={s} type="button" aria-pressed={sizes.includes(s)} onClick={() => setSizes((now) => toggled(SIZES, now, s))}>{s.toUpperCase()}</button>)}
          </>
        )}
        <span>Zoom</span>
        {ZOOMS[layer].map((z) => <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZooms((now) => ({ ...now, [layer]: z }))}>{Math.round(z * 100)}%</button>)}
        <span>Base</span>
        {BASES.map((b) => <button key={b.value} type="button" aria-pressed={base === b.value} onClick={() => setBase(b.value)}>{b.value}</button>)}
        <span>Accent</span>
        {ACCENTS.map((a) => <button key={a.value} type="button" aria-pressed={accent === a.value} onClick={() => setAccent(a.value)}>{a.value}</button>)}
        <span>Density</span>
        {DENSITIES.map((d) => <button key={d.value} type="button" aria-pressed={density === d.value} onClick={() => setDensity(d.value)}>{d.value}</button>)}
      </div>

      {layer === 1 && (
        <div className="kb-canvas__grid" style={{ zoom }}>
          {sizes.map((size) => THEMES.map((theme) => (
            <figure key={`${theme}-${size}`} className="kb-canvas__frame">
              <figcaption>{theme === 'light' ? 'Light' : 'Dark'} · text {size.toUpperCase()}</figcaption>
              <iframe title={`${theme} ${size}`} src={`${origin}${frameHash(look(theme, size))}`} style={{ height: heights[`${theme}-${size}`] ?? 1200 }} />
            </figure>
          )))}
        </div>
      )}

      {layer === 3 && (
        <div className="kb-canvas__rows" style={{ zoom }}>
          {PATTERNS.map((p) => (
            <section key={p.id} className="kb-canvas__row" data-pattern={p.id}>
              <h2>{p.title}</h2>
              <div className="kb-canvas__cols">
                {sizes.map((size) => THEMES.map((theme) => {
                  const key = `pattern:${p.id}:${theme}-${size}`;
                  return (
                    <figure key={key} className="kb-canvas__frame">
                      <figcaption>{theme === 'light' ? 'Light' : 'Dark'} · text {size.toUpperCase()}</figcaption>
                      <iframe title={`${p.title} · ${theme} ${size}`} loading="lazy" src={`${origin}${patternHash(p.id, look(theme, size))}`}
                        style={{ width: p.width, height: p.fixedHeight ?? heights[key] ?? 800 }} />
                    </figure>
                  );
                }))}
              </div>
            </section>
          ))}
        </div>
      )}

      {layer === 4 && (
        <div className="kb-canvas__rows" style={{ zoom }}>
          {SCREENS.map((s) => (
            <section key={s.id} className="kb-canvas__row" data-screen={s.id}>
              <h2>{s.title}</h2>
              {THEMES.map((theme) => (
                <div key={theme} className="kb-canvas__cols">
                  {SCREEN_SIZES.filter((size) => widths.includes(size.w)).map(({ w, h }) => (
                    <figure key={w} className="kb-canvas__frame">
                      <figcaption>{theme === 'light' ? 'Light' : 'Dark'} · {w}×{h}</figcaption>
                      <iframe title={`${s.title} · ${theme} ${w}`} loading="lazy" src={`${origin}${screenHash(s.id, w, look(theme, 'm'))}`} style={{ width: w, height: h }} />
                    </figure>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
