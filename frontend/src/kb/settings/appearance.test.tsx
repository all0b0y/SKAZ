import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';

const openAppearance = async () => {
  const user = userEvent.setup();
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  await user.click(within(dialog).getByRole('button', { name: 'Appearance' }));
  return { user, dialog };
};

const html = () => document.documentElement.dataset;

describe('Settings → Appearance (design system stage 3)', () => {
  it('shows the four presets with SKAZ chosen, then the knobs in the agreed order', async () => {
    renderKb();
    const { dialog } = await openAppearance();
    const presets = within(dialog).getByRole('region', { name: 'Presets' });
    const cards = within(presets).getAllByRole('button', { pressed: undefined }).filter((b) => b.dataset.look);
    expect(cards.map((c) => c.dataset.look)).toEqual(['skaz', 'lecture', 'focus', 'slate']);
    expect(cards[0]).toHaveAttribute('aria-pressed', 'true');
    const rows = [...dialog.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'));
    expect(rows).toEqual(['theme', 'base', 'accent', 'text-size', 'density', 'motion', 'sounds', 'ui-language']);
    expect(html()).toMatchObject({ base: 'milk', accent: 'ink', density: 'comfortable', motion: 'full', sounds: 'off' });
  });

  it('a preset sets its three knobs at once; moving one knob turns it into Custom; Reset brings the default back', async () => {
    renderKb({ prefs: { theme: 'dark', sounds: 'subtle' } });
    const { user, dialog } = await openAppearance();
    await user.click(within(dialog).getByRole('button', { name: /^Lecture/ }));
    expect(html()).toMatchObject({ base: 'sand', accent: 'clay', density: 'spacious' });
    // A preset never touches theme, text size, motion or sounds (decision 32: Lecture/Focus used to switch
    // Motion to calm silently, which stilled the main screen's field).
    expect(html()).toMatchObject({ theme: 'dark', sounds: 'subtle', motion: 'full' });
    expect(within(dialog).getByTestId('look-current')).toHaveTextContent('Lecture');

    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Density' })).getByRole('radio', { name: 'Compact' }));
    expect(within(dialog).getByTestId('look-current')).toHaveTextContent('Custom');
    expect(within(dialog).getByRole('button', { name: /^Lecture/ })).toHaveAttribute('aria-pressed', 'false');
    expect(storedPrefs()).toMatchObject({ base: 'sand', accent: 'clay', density: 'compact', motion: 'full' });

    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    expect(html()).toMatchObject({ base: 'milk', accent: 'ink', density: 'comfortable', motion: 'full', sounds: 'off' });
    expect(html().theme).toBeUndefined();
    expect(within(dialog).getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('the motion knob is the user\'s own: a preset keeps it, and the preset still counts as chosen', async () => {
    renderKb({ prefs: { motion: 'off' } });
    const { user, dialog } = await openAppearance();
    await user.click(within(dialog).getByRole('button', { name: /^Focus/ }));
    expect(html()).toMatchObject({ base: 'paper', accent: 'ink', density: 'compact', motion: 'off' });
    expect(within(dialog).getByTestId('look-current')).toHaveTextContent('Focus');
    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    expect(html().motion).toBe('full');
  });

  it('accent swatches are named radios; motion and sounds are their own knobs', async () => {
    renderKb();
    const { user, dialog } = await openAppearance();
    const accent = within(dialog).getByRole('radiogroup', { name: 'Accent' });
    expect(within(accent).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Ink', 'Clay', 'Petrol', 'Plum', 'Slate']);
    await user.click(within(accent).getByRole('radio', { name: 'Petrol' }));
    expect(html().accent).toBe('petrol');
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Motion' })).getByRole('radio', { name: 'Off' }));
    expect(html().motion).toBe('off');
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Sounds' })).getByRole('radio', { name: 'Subtle' }));
    expect(storedPrefs()).toMatchObject({ accent: 'petrol', motion: 'off', sounds: 'subtle' });
  });

  it('the settings search finds the new knobs', async () => {
    renderKb();
    const user = userEvent.setup();
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const search = within(dialog).getByRole('searchbox', { name: 'Find a setting' });
    for (const [q, row] of [['compact', 'density'], ['animation', 'motion'], ['sound', 'sounds'], ['petrol', 'accent'], ['sand', 'base']] as const) {
      await user.clear(search);
      await user.type(search, q);
      expect(dialog.querySelector(`[data-row="${row}"]`), q).not.toBeNull();
    }
  });
});
