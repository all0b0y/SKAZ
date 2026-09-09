import { useEffect } from 'react';
import type { ThemeMode } from '../state/store';

// Applies the theme to <html data-theme>. In 'system' mode the attribute is
// removed so tokens.css can follow prefers-color-scheme (the pinned default).
export function useTheme(mode: ThemeMode): void {
  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }, [mode]);
}
