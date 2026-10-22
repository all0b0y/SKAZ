import { useReducedMotion } from 'motion/react';
import { FxCanvas } from '../FxCanvas';
import { CONNECT_STILL_T, drawConnect } from './connect';

/** The waiting mark next to «Writing an answer…»: decorative, the text beside it says what happens. */
export function ConnectIndicator({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <FxCanvas className={className ? `kb-fx-connect ${className}` : 'kb-fx-connect'} dpr={2} active reduced={reduced}
      stillT={CONNECT_STILL_T} onFrame={(ctx, _w, _h, t, _dt, colors) => drawConnect(ctx, t, colors)} />
  );
}
