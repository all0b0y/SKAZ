import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

describe('Wiki processing profile', () => {
  it('saves its own catalog model and supported reasoning without changing the chat/default agent', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const originalDefault = world.agents.default;
    const codex = world.agents.agents.find((a) => a.id === 'codex')!;
    const model = codex.models.find((m) => m.efforts.includes('high'))!;
    const { fake } = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    const wiki = within(within(dialog).getByRole('group', { name: 'Wiki model' }));
    await user.click(await wiki.findByRole('button', { name: /^Wiki model:/ }));
    let menu = await screen.findByRole('menu', { name: 'Wiki model' });
    await user.click(within(within(menu).getByRole('group', { name: 'Codex' })).getByRole('menuitemradio', { name: model.name! }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/wiki', body: expect.objectContaining({ wiki_engine: 'codex', wiki_model: model.id }),
    })));
    await user.click(await wiki.findByRole('button', { name: new RegExp(`^Wiki model: Codex, ${model.name}`) }));
    menu = await screen.findByRole('menu', { name: 'Wiki model' });
    await user.click(within(menu).getByRole('radio', { name: 'High' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/wiki', body: { wiki_effort: 'high' },
    })));
    expect(await wiki.findByRole('button', { name: `Wiki model: Codex, ${model.name}, High` })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === '/kb/agents/default')).toHaveLength(0);
    expect(world.agents.default).toBe(originalDefault);
  });
});
