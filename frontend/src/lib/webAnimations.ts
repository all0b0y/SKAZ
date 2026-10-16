/** Web Animations helpers; every caller treats a missing API (jsdom, old engines) as "no motion". */
export const canAnimate = (): boolean =>
  typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

export function cancelAnimations(elements: Iterable<Element>): void {
  for (const element of elements) {
    if (typeof element.getAnimations !== 'function') continue;
    for (const animation of element.getAnimations()) animation.cancel();
  }
}
