/**
 * Appearance knobs and presets (DESIGN-SYSTEM.md, decisions 4–6, 12–17). A preset is a saved
 * combination of the look knobs; it never touches theme, text size or sounds. Pure: no React.
 */

export type BasePref = 'milk' | 'paper' | 'slate' | 'sand';
export type AccentPref = 'ink' | 'clay' | 'petrol' | 'plum' | 'slate';
export type DensityPref = 'compact' | 'comfortable' | 'spacious';
export type MotionPref = 'full' | 'calm' | 'off';
export type SoundsPref = 'off' | 'subtle';

export const BASES: ReadonlyArray<{ value: BasePref; label: string }> = [
  { value: 'milk', label: 'Milk' }, { value: 'paper', label: 'Paper' }, { value: 'slate', label: 'Slate' }, { value: 'sand', label: 'Sand' },
];
export const ACCENTS: ReadonlyArray<{ value: AccentPref; label: string }> = [
  { value: 'ink', label: 'Ink' }, { value: 'clay', label: 'Clay' }, { value: 'petrol', label: 'Petrol' },
  { value: 'plum', label: 'Plum' }, { value: 'slate', label: 'Slate' },
];
export const DENSITIES: ReadonlyArray<{ value: DensityPref; label: string }> = [
  { value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' },
];
export const MOTIONS: ReadonlyArray<{ value: MotionPref; label: string }> = [
  { value: 'full', label: 'Full' }, { value: 'calm', label: 'Calm' }, { value: 'off', label: 'Off' },
];
export const SOUNDS: ReadonlyArray<{ value: SoundsPref; label: string }> = [
  { value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' },
];

export interface Look { base: BasePref; accent: AccentPref; density: DensityPref; motion: MotionPref }

export type PresetId = 'skaz' | 'lecture' | 'focus' | 'slate';

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; note: string; look: Look }> = [
  { id: 'skaz', label: 'SKAZ', note: 'The default look', look: { base: 'milk', accent: 'ink', density: 'comfortable', motion: 'full' } },
  { id: 'lecture', label: 'Lecture', note: 'Long reading, warm and roomy', look: { base: 'sand', accent: 'clay', density: 'spacious', motion: 'calm' } },
  { id: 'focus', label: 'Focus', note: 'Dense, highest contrast', look: { base: 'paper', accent: 'ink', density: 'compact', motion: 'calm' } },
  { id: 'slate', label: 'Slate', note: 'Cool and composed', look: { base: 'slate', accent: 'slate', density: 'comfortable', motion: 'full' } },
];

export const DEFAULT_LOOK: Look = PRESETS[0]!.look;

/** The preset these knobs make, or 'custom' once any knob differs from every preset. */
export function presetOf(look: Look): PresetId | 'custom' {
  const hit = PRESETS.find((p) => p.look.base === look.base && p.look.accent === look.accent
    && p.look.density === look.density && p.look.motion === look.motion);
  return hit ? hit.id : 'custom';
}

export function presetLook(id: PresetId): Look {
  return { ...(PRESETS.find((p) => p.id === id) ?? PRESETS[0]!).look };
}
