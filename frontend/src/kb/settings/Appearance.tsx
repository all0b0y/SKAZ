import { Button, Segmented } from '../ui';
import { usePrefs, useServices } from '../state/context';
import {
  ACCENTS, BASES, DEFAULT_LOOK, DENSITIES, MOTIONS, PRESETS, SOUNDS, presetLook, presetOf,
  type AccentPref, type BasePref, type DensityPref, type MotionPref, type SoundsPref,
} from '../state/appearance';
import { DEFAULT_PREFS } from '../state/prefs';

/**
 * Settings → Appearance (DESIGN-SYSTEM.md, decision 9): presets on top, drawn with the real tokens
 * of their base and accent (`data-kb-scope`), knobs below. Everything applies at once, no Save.
 */

export function PresetGallery() {
  const { prefs } = useServices();
  const base = usePrefs((s) => s.base);
  const accent = usePrefs((s) => s.accent);
  const density = usePrefs((s) => s.density);
  const motion = usePrefs((s) => s.motion);
  const current = presetOf({ base, accent, density, motion });
  const otherDefaults = usePrefs((s) => s.theme === DEFAULT_PREFS.theme && s.textSize === DEFAULT_PREFS.textSize && s.sounds === DEFAULT_PREFS.sounds);
  const isDefault = current === 'skaz' && otherDefaults;
  return (
    <section className="kb-sgroup kb-looks" aria-label="Presets">
      <div className="kb-looks__head">
        <h4 className="kb-sgroup__title">Presets</h4>
        <span className="kb-looks__current" data-testid="look-current">{current === 'custom' ? 'Custom' : PRESETS.find((p) => p.id === current)!.label}</span>
        <Button size="sm" variant="quiet" disabled={isDefault}
          onClick={() => prefs.getState().set({ ...DEFAULT_LOOK, theme: DEFAULT_PREFS.theme, textSize: DEFAULT_PREFS.textSize, sounds: DEFAULT_PREFS.sounds })}>
          Reset to default
        </Button>
      </div>
      <div className="kb-looks__grid">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="kb-look" aria-pressed={current === p.id} data-look={p.id}
            onClick={() => prefs.getState().set(presetLook(p.id))}>
            <span className="kb-look__art" data-kb-scope="" data-base={p.look.base} data-accent={p.look.accent} aria-hidden="true">
              <i className="kb-look__rail" />
              <i className="kb-look__side"><b /><b className="is-on" /><b /></i>
              <i className="kb-look__pane"><b /><b className="is-short" /><i className="kb-look__btn" /></i>
            </span>
            <span className="kb-look__name">{p.label}</span>
            <span className="kb-look__note">{p.note}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function BaseRow() {
  const { prefs } = useServices();
  const value = usePrefs((s) => s.base);
  return <Segmented<BasePref> label="Base" size="sm" value={value} onChange={(v) => prefs.getState().set({ base: v })} options={BASES} />;
}

export function AccentRow() {
  const { prefs } = useServices();
  const value = usePrefs((s) => s.accent);
  return (
    <Segmented<AccentPref> label="Accent" size="sm" value={value} onChange={(v) => prefs.getState().set({ accent: v })}
      options={ACCENTS.map((a) => ({
        value: a.value, name: a.label,
        label: <span className="kb-swatch" data-kb-scope="" data-accent={a.value} aria-hidden="true" />,
      }))} />
  );
}

export function DensityRow() {
  const { prefs } = useServices();
  const value = usePrefs((s) => s.density);
  return <Segmented<DensityPref> label="Density" size="sm" value={value} onChange={(v) => prefs.getState().set({ density: v })} options={DENSITIES} />;
}

export function MotionRow() {
  const { prefs } = useServices();
  const value = usePrefs((s) => s.motion);
  return <Segmented<MotionPref> label="Motion" size="sm" value={value} onChange={(v) => prefs.getState().set({ motion: v })} options={MOTIONS} />;
}

export function SoundsRow() {
  const { prefs } = useServices();
  const value = usePrefs((s) => s.sounds);
  return <Segmented<SoundsPref> label="Sounds" size="sm" value={value} onChange={(v) => prefs.getState().set({ sounds: v })} options={SOUNDS} />;
}
