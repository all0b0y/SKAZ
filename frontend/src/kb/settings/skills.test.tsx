import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

describe('Settings → Skills (0.3.1 H3, variant B)', () => {
  it('shows SKAZ’s own Humanizer, on by default, with a status per agent', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    const nav = within(dialog).getByRole('navigation', { name: 'Settings sections' });
    const work = within(nav).getByRole('heading', { name: 'Work' }).nextElementSibling as HTMLElement;
    expect(within(work).getByRole('button', { name: 'Skills' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: 'Skills' }));
    expect(within(dialog).getByRole('heading', { name: 'Skills', level: 3 })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Skills SKAZ gives to every agent. Only skills from SKAZ’s own folder are used — your personal skills in ~/.claude, ~/.codex and ~/.hermes are not.',
    );
    const humanizer = row(dialog, 'Humanizer');
    // C1-b: Humanizer is for ordinary chat replies only, not wiki processing, cards or tests.
    expect(humanizer).toHaveTextContent('Writes like a person: no filler, no AI tells. Used only in ordinary chat replies, not wiki processing, cards or tests. Quotes from sources are never changed.');
    expect(humanizer).toHaveTextContent('v3.1.0 · MIT · github.com/blader/humanizer');
    expect(await within(humanizer).findByRole('switch', { name: 'Humanizer' })).toBeChecked();
    expect(within(dialog).getByRole('region', { name: 'Writing' })).toContainElement(humanizer);
    const applies = within(dialog).getByRole('region', { name: 'Applies to' });
    expect(await within(row(applies, 'Codex')).findByText('Loaded')).toBeInTheDocument();
    expect(within(row(applies, 'Claude Code')).getByText('Loaded')).toBeInTheDocument();
    expect(within(row(applies, 'Hermes Agent')).getByText('Hermes Agent is not installed.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Turning it off applies from the next answer; running answers finish as they started.');
  });

  it('switching it off is sent at once and every agent reads Off without reopening Settings', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Skills' }));
    const toggle = await within(row(dialog, 'Humanizer')).findByRole('switch', { name: 'Humanizer' });
    await user.click(toggle);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/skills/humanizer', body: { enabled: false },
    })));
    const applies = within(dialog).getByRole('region', { name: 'Applies to' });
    await waitFor(() => expect(within(row(applies, 'Codex')).getByText('Off')).toBeInTheDocument());
    expect(within(row(applies, 'Claude Code')).getByText('Off')).toBeInTheDocument();
    expect(within(row(applies, 'Hermes Agent')).getByText('Off')).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(dialog).toHaveTextContent('Off: agents write without Humanizer from the next answer.');

    await user.click(toggle);
    await waitFor(() => expect(within(row(applies, 'Codex')).getByText('Loaded')).toBeInTheDocument());
    expect(toggle).toBeChecked();
  });

  it('an agent that becomes ready reads Loaded without reopening Settings', async () => {
    const user = userEvent.setup();
    const { services, fake } = renderKb({ world: chatWorld() });
    const world = fake.world;
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Skills' }));
    const hermes = () => row(within(dialog).getByRole('region', { name: 'Applies to' }), 'Hermes Agent');
    expect(await within(hermes()).findByText('Hermes Agent is not installed.')).toBeInTheDocument();
    world.agents.agents = world.agents.agents.map((a) => (a.id === 'hermes' ? { ...a, state: 'ready', installed: true, signed_in: true } : a));
    await act(() => services.agents.getState().refresh());
    await waitFor(() => expect(within(hermes()).getByText('Loaded')).toBeInTheDocument());
  });

  it('search finds the Humanizer row by humanizer, skills, writing and AI style', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    const search = within(dialog).getByRole('searchbox', { name: 'Find a setting' });
    for (const query of ['humanizer', 'skills', 'writing', 'AI style']) {
      await user.clear(search);
      await user.type(search, query);
      expect(within(dialog).getByRole('group', { name: 'Humanizer' }), query).toBeInTheDocument();
    }
  });
});
