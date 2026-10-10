import { canAnimate, cancelAnimations } from '../../lib/webAnimations';

/** Startup motion: an audio track that plays while the local service starts. */

const bars = (wave: HTMLElement | null) => Array.from(wave?.querySelectorAll<HTMLElement>('span') ?? []);

/** The track moves like a voice; reduced motion only breathes. Returns a stop function. */
export function playWave(wave: HTMLElement | null, reduced: boolean): () => void {
  if (!canAnimate()) return () => undefined;
  const items = bars(wave);
  cancelAnimations(items);
  items.forEach((bar, index) => {
    // A fixed contour per bar, so the track reads as speech rather than noise.
    const peak = 0.35 + 0.65 * Math.abs(Math.sin(index * 1.7));
    const dip = 0.18 + 0.45 * Math.abs(Math.cos(index * 0.9));
    bar.animate(
      reduced
        ? [{ opacity: 0.45 }, { opacity: 1 }, { opacity: 0.45 }]
        : [0.25, peak, dip, Math.min(1, peak + 0.2), 0.25].map((height) => ({ transform: `scaleY(${height.toFixed(2)})` })),
      { duration: reduced ? 1800 : 1000 + (index % 5) * 140, delay: index * 35, iterations: Infinity, easing: 'ease-in-out' },
    );
  });
  return () => cancelAnimations(items);
}

/** The start failed: the track goes flat (its colour comes from CSS). */
export function flatten(wave: HTMLElement | null): void {
  if (!canAnimate()) return;
  for (const bar of bars(wave)) {
    const from = getComputedStyle(bar).transform;
    cancelAnimations([bar]);
    bar.animate([{ transform: from === 'none' ? 'scaleY(0.6)' : from }, { transform: 'scaleY(0.12)' }],
      { duration: 320, easing: 'ease-out', fill: 'forwards' });
  }
}

/** Ready: the screen fades while the workspace already takes input. */
export async function fadeAway(gate: HTMLElement, reduced: boolean): Promise<void> {
  if (!canAnimate()) return;
  await gate.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 120 : 220, easing: 'ease', fill: 'forwards' })
    .finished.catch(() => undefined);
}
