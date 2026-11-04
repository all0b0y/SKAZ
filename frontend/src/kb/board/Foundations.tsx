import { useState } from 'react';
import { m } from 'motion/react';
import { Icon, ICON_NAMES } from '../ui';
import { EXIT, SPRING_LARGE, SPRING_SMALL } from '../ui/motion';
import type { CssAudit } from './audit';
import { themeValue, type TokenBlocks, type TokenGroup } from './tokens';
import { fmtHex, hue, hueDistance, lightness, ratio, useResolvedColors } from './resolve';

/** Layer 1 of the design board: tokens as they resolve in this frame's theme and text size. */

const SURFACES = ['--kb-rail', '--kb-side', '--kb-bg', '--kb-pane'] as const;

/** Foregrounds: text must reach 4.5:1, graphics (dots, folder marks, FX) 3:1; lines are informational. */
const FOREGROUNDS: ReadonlyArray<{ name: string; kind: 'text' | 'graphic' | 'line' }> = [
  { name: '--kb-text', kind: 'text' },
  { name: '--kb-muted', kind: 'text' },
  { name: '--kb-muted-strong', kind: 'text' },
  { name: '--kb-accent', kind: 'text' },
  { name: '--kb-danger', kind: 'text' },
  { name: '--kb-warn', kind: 'text' },
  { name: '--kb-ok', kind: 'text' },
  { name: '--kb-folder-1', kind: 'graphic' },
  { name: '--kb-folder-2', kind: 'graphic' },
  { name: '--kb-folder-3', kind: 'graphic' },
  { name: '--kb-folder-4', kind: 'graphic' },
  { name: '--kb-fx-accent', kind: 'graphic' },
  { name: '--kb-line', kind: 'line' },
];
const BACKGROUNDS = ['--kb-bg', '--kb-pane', '--kb-side', '--kb-rail', '--kb-accent-soft'] as const;

/** Pairs that only appear together (a fill and its text, a soft tint and its tone). */
const PAIRS: ReadonlyArray<[string, string, string]> = [
  ['--kb-on-fill', '--kb-fill', 'Primary button, toast'],
  ['--kb-badge-text', '--kb-danger', 'Danger action in the selection bar'],
  ['--kb-bg', '--kb-text', 'Tooltip'],
  ['--kb-danger', '--kb-danger-soft', 'Danger tint'],
  ['--kb-warn', '--kb-warn-soft', 'Warning tint'],
  ['--kb-ok', '--kb-ok-soft', 'Added (agent change)'],
  ['--kb-text', '--kb-accent-soft', 'Hover / selected row'],
];

const HUE_TOKENS = ['--kb-accent', '--kb-fx-accent', '--kb-folder-1', '--kb-folder-2', '--kb-folder-3', '--kb-folder-4'];

const need = (kind: 'text' | 'graphic' | 'line') => (kind === 'text' ? 4.5 : kind === 'graphic' ? 3 : 0);

function Ratio({ value, min }: { value: number | null; min: number }) {
  if (value === null) return <span className="kb-board__ratio">—</span>;
  const verdict = min === 0 ? 'info' : value >= min ? 'pass' : 'fail';
  return <span className={`kb-board__ratio is-${verdict}`} data-verdict={verdict}>{value.toFixed(2)}</span>;
}

export function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="kb-board__section" id={id} data-board-section={id}>
      <h2 className="kb-board__h2">{title}</h2>
      {note && <p className="kb-board__note">{note}</p>}
      {children}
    </section>
  );
}

export interface FoundationsProps {
  blocks: TokenBlocks;
  groups: Record<TokenGroup, string[]>;
  audit: CssAudit;
  theme: 'light' | 'dark';
  size: 's' | 'm' | 'l';
}

export function Foundations({ blocks, groups, audit, theme, size }: FoundationsProps) {
  const colorNames = [...new Set([...groups.color, ...SURFACES, ...BACKGROUNDS, ...FOREGROUNDS.map((f) => f.name)])];
  const colors = useResolvedColors(colorNames);
  /** Value of a non-colour token in this frame (text size overrides the base block; a spacing step
   *  shows its px at density 1, the rest of its formula is the density rounding). */
  const literal = (name: string) => {
    const step = /^--kb-sp-(\d+)$/.exec(name);
    if (step) return `${step[1]}px × density`;
    const raw = (size !== 'm' ? blocks.textSize[size]?.get(name) : undefined) ?? blocks.light.get(name);
    return raw === undefined ? '—' : themeValue(raw, theme);
  };

  return (
    <>
      <Section id="surfaces" title="Surfaces" note="Column layers, darkest to lightest. ΔL = OKLCH lightness step to the next layer; under 0.02 the layers read as one.">
        <div className="kb-board__layers">
          {SURFACES.map((name, i) => {
            const l = lightness(colors.get(name));
            const next = SURFACES[i + 1];
            const ln = next ? lightness(colors.get(next)) : null;
            const step = l !== null && ln !== null ? ln - l : null;
            return (
              <div key={name} className="kb-board__layer" style={{ background: `var(${name})` }} data-token={name}>
                <b>{name.replace('--kb-', '')}</b>
                <span>{fmtHex(colors.get(name))}</span>
                <span>L {l === null ? '—' : l.toFixed(3)}</span>
                {next && <span className={step !== null && Math.abs(step) < 0.02 ? 'kb-board__warn' : undefined}>ΔL → {step === null ? '—' : step.toFixed(3)}</span>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section id="colors" title={`Colour tokens · ${groups.color.length}`} note="«same» = one value in both themes (no light-dark); «mix» = derived with color-mix.">
        <div className="kb-board__swatches">
          {groups.color.map((name) => (
            <div key={name} className="kb-board__swatch" data-token={name}>
              <i style={{ background: `var(${name})` }} />
              <b>{name.replace('--kb-', '')}</b>
              <span>{fmtHex(colors.get(name))}</span>
              {(() => {
                const v = blocks.light.get(name) ?? '';
                if (v.includes('color-mix')) return <span className="kb-board__tag">mix</span>;
                if (!v.includes('light-dark')) return <span className="kb-board__tag">same</span>;
                return null;
              })()}
            </div>
          ))}
        </div>
      </Section>

      <Section id="contrast" title="Contrast (WCAG 2.x)" note="Text ≥ 4.5, graphics ≥ 3, lines informational. Translucent tokens are composited over the background.">
        <table className="kb-board__table">
          <thead><tr><th />{BACKGROUNDS.map((b) => <th key={b}>{b.replace('--kb-', '')}</th>)}</tr></thead>
          <tbody>
            {FOREGROUNDS.map(({ name, kind }) => (
              <tr key={name}>
                <th><span className="kb-board__dot" style={{ background: `var(${name})` }} />{name.replace('--kb-', '')}<small> {kind}</small></th>
                {BACKGROUNDS.map((b) => (
                  <td key={b} style={{ background: `var(${b})`, color: `var(${name})` }}>
                    <Ratio value={ratio(colors.get(name), colors.get(b))} min={need(kind)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <table className="kb-board__table kb-board__table--pairs">
          <tbody>
            {PAIRS.map(([fg, bg, where]) => (
              <tr key={fg + bg}>
                <td style={{ background: `var(${bg})`, color: `var(${fg})` }}>Aa {fg.replace('--kb-', '')} on {bg.replace('--kb-', '')}</td>
                <td><Ratio value={ratio(colors.get(fg), colors.get(bg))} min={4.5} /></td>
                <td className="kb-board__muted">{where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="hues" title="Hues" note="OKLCH hue; «grey» = no hue. Rule for stage 2: an accent hue stays ≥ 30° away from every folder hue.">
        <table className="kb-board__table">
          <thead><tr><th />{HUE_TOKENS.map((t) => <th key={t}>{t.replace('--kb-', '')}</th>)}</tr></thead>
          <tbody>
            <tr>
              <th>hue</th>
              {HUE_TOKENS.map((t) => { const h = hue(colors.get(t)); return <td key={t}><span className="kb-board__dot" style={{ background: `var(${t})` }} />{h === null ? 'grey' : `${Math.round(h)}°`}</td>; })}
            </tr>
            {HUE_TOKENS.map((a) => (
              <tr key={a}>
                <th>{a.replace('--kb-', '')}</th>
                {HUE_TOKENS.map((b) => {
                  const d = a === b ? null : hueDistance(hue(colors.get(a)), hue(colors.get(b)));
                  return <td key={b} className={d !== null && d < 30 ? 'kb-board__warn' : undefined}>{d === null ? '' : `${Math.round(d)}°`}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="type" title="Type" note="Inter for everything, Unbounded 600/700 for headings.">
        <div className="kb-board__type">
          {groups.type.map((name) => (
            <div key={name} className="kb-board__typerow" data-token={name}>
              <code>{name}</code><code>{literal(name)}</code>
              <span style={{ fontSize: `var(${name})`, fontFamily: name.startsWith('--t-h') ? 'var(--kb-font-display)' : undefined, fontWeight: name.startsWith('--t-h') ? 700 : undefined }}>
                Расшифровка лекции · Lecture notes 01:24
              </span>
            </div>
          ))}
        </div>
        <div className="kb-board__fonts">
          {[400, 500, 600, 700].map((w) => <p key={w} style={{ fontWeight: w }}>Inter {w} — Съешь же ещё этих мягких французских булок</p>)}
          {[600, 700].map((w) => <p key={w} style={{ fontFamily: 'var(--kb-font-display)', fontWeight: w, fontSize: 'var(--t-lg)' }}>Unbounded {w} — Конспект SKAZ</p>)}
          <p style={{ fontFamily: 'var(--kb-font-mono)' }}>Mono — 00:41:12 · p. 31</p>
        </div>
      </Section>

      <Section id="space" title="Spacing, radii, shadows, chrome">
        <div className="kb-board__row">
          <div className="kb-board__col">
            {groups.space.map((name) => (
              <div key={name} className="kb-board__bar" data-token={name}>
                <code>{name} · {literal(name)}</code><i style={{ width: `var(${name})` }} />
              </div>
            ))}
          </div>
          <div className="kb-board__radii">
            {groups.radius.map((name) => (
              <div key={name} data-token={name}><i style={{ borderRadius: `var(${name})` }} /><code>{name.replace('--kb-', '')} · {literal(name)}</code></div>
            ))}
          </div>
        </div>
        <div className="kb-board__shadows">
          {groups.shadow.map((name) => <div key={name} data-token={name} style={{ boxShadow: `var(${name})` }}><code>{name.replace('--kb-', '')}</code></div>)}
        </div>
        <p className="kb-board__muted">{groups.chrome.map((n) => `${n.replace('--kb-', '')} ${literal(n)}`).join(' · ')}</p>
      </Section>

      <Section id="icons" title={`Icons · ${ICON_NAMES.length}`}>
        <div className="kb-board__icons">
          {ICON_NAMES.map((name) => <div key={name}><Icon name={name} size={16} /><code>{name}</code></div>)}
        </div>
      </Section>

      <MotionSection />

      <Section id="drift" title="Drift: values written by hand" note="From every renderer CSS file except tokens.css. These are the places a knob will not reach.">
        <div className="kb-board__row">
          <div className="kb-board__col">
            <h3 className="kb-board__h3">Literal colours · {audit.colors.length}</h3>
            <ul className="kb-board__list">
              {Object.entries(audit.colors.reduce<Record<string, string[]>>((acc, c) => { (acc[c.file] ??= []).push(c.value); return acc; }, {}))
                .sort((a, b) => b[1].length - a[1].length)
                .map(([file, values]) => <li key={file}><b>{file}</b> {values.length}: {[...new Set(values)].join(', ')}</li>)}
            </ul>
            <h3 className="kb-board__h3">box-shadow not from a token · {audit.shadows}</h3>
          </div>
          <div className="kb-board__col">
            <h3 className="kb-board__h3">font-size not from a token (em is relative) · {audit.fontSizes.reduce((n, t) => n + t.count, 0)}</h3>
            <ul className="kb-board__list">{audit.fontSizes.map((t) => <li key={t.value}><b>{t.value}</b> ×{t.count} — {t.files.join(', ')}</li>)}</ul>
            <h3 className="kb-board__h3">border-radius in px · {audit.radii.reduce((n, t) => n + t.count, 0)}</h3>
            <ul className="kb-board__list">{audit.radii.map((t) => <li key={t.value}><b>{t.value}</b> ×{t.count} — {t.files.join(', ')}</li>)}</ul>
          </div>
        </div>
        <h3 className="kb-board__h3">Spacing in px (padding / margin / gap) — grey = on the 4 px grid</h3>
        <div className="kb-board__hist">
          {audit.spacing.map((s) => (
            <div key={s.value} className={s.onGrid ? undefined : 'is-off'} title={`${s.value} ×${s.count}`}>
              <i style={{ height: Math.min(120, 6 + s.count * 1.5) }} /><code>{s.value.replace('px', '')}</code><small>{s.count}</small>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function MotionSection() {
  const [on, setOn] = useState(false);
  const rows = [
    { name: 'SPRING_SMALL', t: SPRING_SMALL },
    { name: 'SPRING_LARGE', t: SPRING_LARGE },
    { name: 'EXIT', t: EXIT },
  ];
  return (
    <Section id="motion" title="Motion" note="The three shared transitions (ui/motion.tsx). Click to play.">
      <button type="button" className="kb-board__play" onClick={() => setOn((v) => !v)}>Play</button>
      {rows.map(({ name, t }) => (
        <div key={name} className="kb-board__motion">
          <code>{name} {JSON.stringify(t)}</code>
          <div className="kb-board__track"><m.i animate={{ x: on ? 220 : 0 }} transition={t} /></div>
        </div>
      ))}
    </Section>
  );
}
