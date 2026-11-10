import { useEffect, useMemo, useState } from 'react';
import type { KbFragment, KbMaterialRef, KbMaterialRepeats, KbParagraphRepeat } from '../../api/kb/types.gen';
import { useUi } from '../state/context';
import { useMarksClients } from './marksClients';
import './marks.css';

/**
 * N3 in the material view (v4 states 15–16): a quiet mark at each passage the wiki already has —
 * "Already in your wiki · from Lecture 7" — and "Hide what you've read", which folds the fully repeated
 * passages with a visible way back. Wiki coverage is not the reader's understanding, so the wording says
 * what is in the wiki and nothing about what was learned. A material the check has not seen
 * (`not_checked`) shows nothing here.
 */

/** The repeats of one material; nothing (and no error on screen) while they cannot be read. */
export function useMaterialRepeats(materialId: string): KbMaterialRepeats | null {
  const { repeats } = useMarksClients();
  const [value, setValue] = useState<KbMaterialRepeats | null>(null);
  useEffect(() => {
    let live = true;
    setValue(null);
    repeats.material(materialId).then((r) => { if (live) setValue(r); }, () => { if (live) setValue(null); });
    return () => { live = false; };
  }, [repeats, materialId]);
  return value;
}

export interface RepeatSpot {
  paragraph: KbParagraphRepeat;
  /** The first fragment of the paragraph in the material: it carries the label. */
  first: boolean;
}

/** What the transcript needs to draw the marks: which fragments are repeated, and the folding state. */
export interface RepeatView {
  bySeg: ReadonlyMap<number, RepeatSpot>;
  /** "Hide what you've read" is on. */
  hide: boolean;
  /** Paragraphs the reader opened again with "Show". */
  shown: ReadonlySet<string>;
  show: (paragraphId: string) => void;
}

/** `fragment_ids` of a paragraph are the fragments' `seg` numbers. */
export function repeatSpots(repeats: KbMaterialRepeats | null, fragments: readonly KbFragment[]): Map<number, RepeatSpot> {
  const out = new Map<number, RepeatSpot>();
  if (!repeats || repeats.status !== 'checked') return out;
  const seen = new Set<string>();
  const owner = new Map<number, KbParagraphRepeat>();
  for (const paragraph of repeats.paragraphs) {
    if (paragraph.repeated_statements === 0) continue;
    for (const seg of paragraph.fragment_ids) owner.set(seg, paragraph);
  }
  for (const fragment of fragments) {
    const paragraph = owner.get(fragment.seg);
    if (!paragraph) continue;
    out.set(fragment.seg, { paragraph, first: !seen.has(paragraph.paragraph_id) });
    seen.add(paragraph.paragraph_id);
  }
  return out;
}

export const isFolded = (view: RepeatView, spot: RepeatSpot, target: number | null): boolean =>
  view.hide && spot.paragraph.fully_repeated && !view.shown.has(spot.paragraph.paragraph_id)
  && !(target !== null && spot.paragraph.fragment_ids.includes(target));

/** The state behind the toggle and the marks of one material. */
export function useRepeatView(repeats: KbMaterialRepeats | null, fragments: readonly KbFragment[], materialId: string) {
  const bySeg = useMemo(() => repeatSpots(repeats, fragments), [repeats, fragments]);
  const [hide, setHide] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setHide(false); setShown(new Set()); }, [materialId]);
  const foldable = useMemo(() => [...bySeg.values()].some((s) => s.paragraph.fully_repeated), [bySeg]);
  const view: RepeatView | null = bySeg.size === 0 ? null : {
    bySeg, hide, shown, show: (id) => setShown((s) => new Set(s).add(id)),
  };
  return { view, foldable, hide, setHide: (value: boolean) => { setHide(value); if (!value) setShown(new Set()); } };
}

/** "Hide what you've read": a plain checkbox, off by default. */
export function RepeatToggle({ hide, onChange }: { hide: boolean; onChange: (hide: boolean) => void }) {
  return (
    <label className="kb-rep__toggle">
      <input type="checkbox" checked={hide} onChange={(e) => onChange(e.target.checked)} />
      <span>Hide what you've read</span>
    </label>
  );
}

function Sources({ materials }: { materials: readonly KbMaterialRef[] }) {
  const open = useUi((s) => s.openDocument);
  return (
    <>
      {materials.map((m, i) => (
        <span key={m.material_id}>
          {i > 0 && ', '}
          <button type="button" className="kb-rep__link" onClick={() => open({ type: 'material', id: m.material_id })}>{m.title}</button>
        </span>
      ))}
    </>
  );
}

const lead = (p: KbParagraphRepeat) => (p.fully_repeated ? 'Already in your wiki' : `Partly in your wiki · ${p.repeated_statements} of ${p.total_statements} statements`);

/** The line above (or instead of) a repeated passage. */
export function RepeatLabel({ spot }: { spot: RepeatSpot }) {
  const { paragraph } = spot;
  return (
    <span className="kb-rep__label" data-testid="repeat-label">
      {lead(paragraph)}
      {paragraph.from_materials.length > 0 && <> · from <Sources materials={paragraph.from_materials} /></>}
    </span>
  );
}

/** A folded passage: one quiet line and the way back. */
export function RepeatFolded({ spot, onShow }: { spot: RepeatSpot; onShow: () => void }) {
  return (
    <span className="kb-rep__folded" data-testid="repeat-folded">
      <span className="kb-rep__folded-head">Repeated passage hidden · <button type="button" className="kb-rep__link" onClick={onShow}>Show</button></span>
      <RepeatLabel spot={spot} />
    </span>
  );
}
