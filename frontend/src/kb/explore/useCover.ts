import { useCallback, useEffect, useRef } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { ExploreState } from './exploreState';

/**
 * A switch for one source of cover — a menu or a dialog over the Explore page. While it is on, the paper's
 * native view stays out of sight (it would be drawn above the menu). It switches itself off when the
 * component that owns it goes away, so an open menu can never leave the paper hidden for good.
 */
export function useCover(store: StoreApi<ExploreState>): (on: boolean) => void {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    release.current?.();
    release.current = null;
  }, []);
  return useCallback((on: boolean) => {
    if (on && !release.current) release.current = store.getState().cover();
    else if (!on && release.current) {
      release.current();
      release.current = null;
    }
  }, [store]);
}
