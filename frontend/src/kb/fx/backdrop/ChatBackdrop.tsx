import { useCallback, useRef, useState } from 'react';
import { FxCanvas } from '../FxCanvas';
import { BackdropScene } from './scene';

export interface ChatBackdropProps {
  /** The agent is writing an answer in this chat (an assistant message is streaming). */
  working: boolean;
  /** The chat view is on screen (the loop stops while its section is hidden). */
  active: boolean;
  reduced: boolean;
}

/**
 * The backdrop behind a chat with messages (CHAT-BACKDROP-SPEC): three soft dither patches that move
 * only while the agent works. At rest it is one still frame and no loop: the loop starts with the
 * work, runs at ~15 fps while the energy is up, and stops once everything has been still for
 * SETTLE_S. Reduced motion: one still frame at energy 0, whatever the agent does. Decorative only —
 * aria-hidden, no pointer events, no focus; it fills the stage, so it does not scroll with the thread.
 */
export function ChatBackdrop({ working, active, reduced }: ChatBackdropProps) {
  const sceneRef = useRef<BackdropScene | null>(null);
  sceneRef.current ??= new BackdropScene();
  const scene = sceneRef.current;
  const moving = working && !reduced;
  scene.setWorking(moving);
  if (reduced) scene.energy = 0; // the still frame is the resting one
  const [running, setRunning] = useState(moving);
  // Work started: run the loop again (a render-time update of this component's own state).
  if (moving && !running) setRunning(true);
  const runningRef = useRef(running);
  runningRef.current = running;
  const frameMs = useCallback(() => scene.frameMs, [scene]);

  return (
    <div className="kb-chat__backdrop" aria-hidden="true" data-working={moving ? 'true' : undefined} data-still={reduced ? 'true' : undefined}>
      <FxCanvas className="kb-fx-backdrop" active={active && (reduced || running)} reduced={reduced} frameMs={frameMs}
        onFrame={(ctx, w, h, _t, dt, colors) => {
          scene.step(dt);
          scene.draw(ctx, w, h, colors);
          if (runningRef.current && scene.settled) {
            runningRef.current = false;
            setRunning(false);
          }
        }} />
    </div>
  );
}
