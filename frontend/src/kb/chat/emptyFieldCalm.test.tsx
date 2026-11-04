import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

const centre = () => screen.getByRole('region', { name: 'Chat' });
const stage = () => centre().querySelector('.kb-chat__stage')!;

// Decision 32: at «calm» the main screen's field stays interactive (clicks still grow links); only the
// slow background drift stops. Off and the system's reduced motion keep the still frame
// (emptyFieldReduced.test.tsx).
describe('Empty chat field at motion «calm»', () => {
  it('reacts to clicks and does not drift', async () => {
    renderKb({ world: chatWorld(), prefs: { motion: 'calm' } });
    await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
    expect(stage()).toHaveAttribute('data-interactive', 'true');
    expect(stage()).not.toHaveAttribute('data-still');
    expect(stage()).toHaveAttribute('data-drift', 'still');
  });

  it('at «off» the field is one still frame without clicks, as before', async () => {
    renderKb({ world: chatWorld(), prefs: { motion: 'off' } });
    await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
    expect(stage()).toHaveAttribute('data-still', 'true');
    expect(stage()).not.toHaveAttribute('data-interactive');
  });
});
