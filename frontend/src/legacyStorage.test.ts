import { expect, it } from 'vitest';
import { migrateLegacyStorage } from './legacyStorage';

it('migrates legacy preferences without overwriting newer values or unrelated keys', () => {
  localStorage.clear();
  localStorage.setItem('audiohelper.theme', 'dark');
  localStorage.setItem('audiohelper.noteTabs', '[1]');
  localStorage.setItem('skaz.theme', 'light');
  localStorage.setItem('unrelated', 'keep');
  migrateLegacyStorage(localStorage);
  migrateLegacyStorage(localStorage);
  expect(localStorage.getItem('skaz.theme')).toBe('light');
  expect(localStorage.getItem('skaz.noteTabs')).toBe('[1]');
  expect(localStorage.getItem('audiohelper.noteTabs')).toBeNull();
  expect(localStorage.getItem('unrelated')).toBe('keep');
  localStorage.clear();
});
