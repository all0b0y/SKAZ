import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// prefers-reduced-motion: reduce — set before Motion first reads it (this file only).
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

const centre = () => screen.getByRole('region', { name: 'Chat' });
const backdrop = () => centre().querySelector('.kb-chat__backdrop');

describe('Chat backdrop with reduced motion (CHAT-BACKDROP-SPEC «Motion»)', () => {
  it('a still frame that does not start working while an answer is written', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    renderKb({ world });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    await within(centre()).findByRole('article', { name: 'Answer' });
    expect(backdrop()).toHaveAttribute('data-still', 'true');
    await user.click(screen.getByTestId('message-input'));
    await user.keyboard('And the base of the logarithm?{Enter}');
    await within(centre()).findByText('Writing an answer…');
    expect(backdrop()).toHaveAttribute('data-still', 'true');
    expect(backdrop()).not.toHaveAttribute('data-working');
  });
});
