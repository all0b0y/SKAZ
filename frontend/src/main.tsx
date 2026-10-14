import './legacyStorage';
import { chooseInterface } from './kb/uiChoice';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// New interface (Knowledge Wiki) only when asked for: VITE_SKAZ_UI=kb at build time or
// localStorage['skaz.ui'] = 'kb'. Otherwise the current App, as before. Each interface brings
// its own global styles, so neither leaks into the other.
const choice = chooseInterface(import.meta.env.VITE_SKAZ_UI, () => localStorage.getItem('skaz.ui'));
if (choice === 'kb') {
  void import('./kb/main').then(({ mount }) => mount(container));
} else {
  void import('./legacyMain').then(({ mount }) => mount(container));
}
