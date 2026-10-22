import { forwardRef, useImperativeHandle, useRef, type ComponentType } from 'react';
import type { IconHandle } from '@animateicons/react';

/**
 * Tests for the feedback motion of the animated icons (animated-icons spec): wrap the real icon module in
 * `vi.mock(path, async (load) => ({ XIcon: spyOnIcon('concept', (await load()).XIcon) }))`. The icon still
 * renders and animates for real; every `startAnimation()` asked of it is recorded here, in order.
 */
export const iconPlays: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spyOnIcon(name: string, Real: ComponentType<any>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Spy = forwardRef<IconHandle, any>(function SpiedIcon(props, ref) {
    const inner = useRef<IconHandle | null>(null);
    useImperativeHandle(ref, () => ({
      startAnimation: () => { iconPlays.push(name); inner.current?.startAnimation(); },
      stopAnimation: () => { inner.current?.stopAnimation(); },
    }));
    return <Real {...props} ref={inner} />;
  });
  return Spy;
}
