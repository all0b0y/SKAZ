import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { chatWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';

it.each(['cancel', 'refuse', 'save', 'move focus'] as const)(
  'keeps keyboard focus on the selected wiki action through %s', async (outcome) => {
    const user = userEvent.setup();
    const { services } = renderKb({ world: chatWorld() });
    const chats = screen.getByRole('region', { name: 'Chats' });
    await user.click(await within(chats).findByRole('button', { name: /Why is there a logarithm/ }));
    const answer = within(await screen.findByRole('article', { name: 'Answer' }));
    const save = answer.getByRole('button', { name: 'Save to wiki' });
    const original = services.chats.getState().saveMessage;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    services.chats.setState({
      saveMessage: async (...args) => {
        await wait;
        if (outcome === 'save') return original(...args);
        return { ok: false, error: outcome === 'cancel' ? 'Wiki shaping was cancelled.' : 'Shaping failed.' };
      },
      stop: async () => { release(); return { ok: true, value: undefined }; },
    });
    act(() => save.focus());
    await user.keyboard('{Enter}');
    const cancel = answer.getByRole('button', { name: 'Cancel wiki shaping' });
    expect(cancel).toHaveFocus();
    expect(answer.getByRole('button', { name: 'Shaping for wiki…' })).toHaveAttribute('aria-busy', 'true');
    const elsewhere = answer.getByRole('button', { name: 'Copy' });
    if (outcome === 'move focus') act(() => elsewhere.focus());
    if (outcome === 'cancel') await user.keyboard('{Enter}');
    else await act(async () => release());
    const settled = await answer.findByRole('button', { name: outcome === 'save' ? 'Saved to wiki — open' : 'Save to wiki' });
    expect(outcome === 'move focus' ? elsewhere : settled).toHaveFocus();
  },
);
