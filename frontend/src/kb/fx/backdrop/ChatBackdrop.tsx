import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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

  const host = useRef<HTMLDivElement | null>(null);
  const paintBridge = useCallback(() => {
    const source = host.current?.querySelector('canvas');
    const app = host.current?.closest('.kb-app');
    const target = app?.querySelector<HTMLElement>('.kb-chatrow.is-current');
    const canvas = target?.closest('.kb-tabhost')?.querySelector<HTMLCanvasElement>('.kb-tab--bridge:not([hidden]) .kb-tab__backdrop');
    if (!source || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const origin = source.getBoundingClientRect();
    if (!rect.width || !rect.height || !origin.height) return;
    canvas.width = Math.ceil(rect.width);
    canvas.height = Math.ceil(rect.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const r = Math.min(10, w, h / 2);
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(w - r, r);
    ctx.arcTo(w, r, w, 0, r);
    ctx.lineTo(w, h);
    ctx.arcTo(w, h - r, w - r, h - r, r);
    ctx.lineTo(0, h - r);
    ctx.clip();
    const scaleX = source.width / origin.width;
    const scaleY = source.height / origin.height;
    ctx.drawImage(source, (rect.left - origin.left) * scaleX, (rect.top - origin.top) * scaleY,
      rect.width * scaleX, rect.height * scaleY, 0, 0, w, h);
  }, []);
  useLayoutEffect(() => {
    const app = host.current?.closest('.kb-app');
    if (!app) return;
    const side = app.querySelector('.kb-side');
    const observer = new MutationObserver(paintBridge);
    if (side) observer.observe(side, { subtree: true, attributes: true, childList: true, attributeFilter: ['hidden', 'class', 'style'] });
    app.addEventListener('scroll', paintBridge, true);
    return () => { observer.disconnect(); app.removeEventListener('scroll', paintBridge, true); };
  }, [paintBridge]);
  return (
    <div ref={host} className="kb-chat__backdrop" aria-hidden="true" data-overlay="" data-working={moving ? 'true' : undefined} data-still={reduced ? 'true' : undefined}>
      <FxCanvas className="kb-fx-backdrop" active={active && (reduced || running)} reduced={reduced} frameMs={frameMs}
        onFrame={(ctx, w, h, _t, dt, colors) => {
          scene.step(dt);
          scene.draw(ctx, w, h, colors);
          paintBridge();
          if (runningRef.current && scene.settled) {
            runningRef.current = false;
            setRunning(false);
          }
        }} />
    </div>
  );
}
