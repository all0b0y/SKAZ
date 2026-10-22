import { FxCanvas } from '../FxCanvas';
import { drawSpeech } from './speech';

/**
 * The recording capsule's level bars: a decorative canvas (aria-hidden) driven by the real input
 * levels. No loop — it repaints only when `levels` changes (`redrawKey`). `data-levels` echoes the
 * store's raw levels (the canvas draws them interpolated across 7 bars), a test hook only.
 */
export function SpeechBars({ levels }: { levels: readonly number[] }) {
  return (
    <span className="kb-lvl" aria-hidden="true" data-levels={levels.join(',')}>
      <FxCanvas className="kb-fx-speech" dpr={2} active={false} reduced={false} redrawKey={levels}
        onFrame={(ctx, w, h, _t, _dt, colors) => drawSpeech(ctx, w, h, levels, colors)} />
    </span>
  );
}
