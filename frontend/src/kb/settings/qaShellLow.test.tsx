// Small shell/onboarding/settings findings of the 2026-10-16 QA (area A, Low rows).
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { unconfiguredWorld } from '../test/fakeBridge';

const openSettingsByKey = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};

describe('QA area A — Low', () => {
  it('A3: the gear hint names the problem in sentence case, as the plate does', async () => {
    renderKb({ world: chatWorld() });
    const gear = await screen.findByRole('button', { name: 'Settings, needs attention' });
    gear.focus();
    expect(await within(gear).findByTestId('rail-label')).toHaveTextContent('Hermes Agent isn’t installed');
    expect(within(gear).getByTestId('rail-label')).not.toHaveTextContent('hermes agent');
  });

  it('A33: ⌘, opens the section with the problem, like the gear', async () => {
    renderKb({ world: chatWorld() });
    await screen.findByTestId('settings-dot');
    const dialog = await openSettingsByKey();
    expect(within(dialog).getByRole('heading', { name: 'Accounts & keys', level: 3 })).toBeInTheDocument();
  });

  it('A5: after Check finds no Hermes, “Nothing starts until you press Check” is gone', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettingsByKey();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const hermes = within(dialog).getByRole('group', { name: 'Hermes Agent' });
    expect(within(hermes).getByRole('note')).toHaveTextContent('Nothing starts until you press Check.');
    await user.click(within(hermes).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(within(hermes).queryByRole('note')).not.toBeInTheDocument());
  });

  it('A17: Escape in the key form closes the form, not Settings', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettingsByKey();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const soniox = within(dialog).getByRole('group', { name: 'Soniox' });
    await user.click(within(soniox).getByRole('button', { name: 'Replace…' }));
    await user.type(within(soniox).getByLabelText('Soniox key'), 'half-a-key');
    await user.keyboard('{Escape}');
    expect(within(soniox).queryByLabelText('Soniox key')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('A31: the “No Soniox key” plate offers Add key…, which leads to Accounts & keys', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.keys.providers = world.keys.providers.map((p) => (p.id === 'soniox' ? { ...p, configured: false, valid: null } : p));
    world.health.sections = world.health.sections.map((s): typeof s => (s.id === 'speech' ? { id: 'speech', state: 'error', problems: [{
      id: 'speech-soniox-key', severity: 'error', title: 'No Soniox key', reason: 'Speech goes to Soniox, but no Soniox key is stored.',
      still_works: 'Everything except new speech recognition.', stopped: 'New recordings.', progress: null, actions: [{ id: 'use_local', label: 'Recognise on this Mac', primary: false }],
    }] } : s));
    renderKb({ world });
    const dialog = await openSettingsByKey();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    await user.click(await within(dialog).findByRole('button', { name: 'Add key…' }));
    expect(within(dialog).getByRole('heading', { name: 'Accounts & keys', level: 3 })).toBeInTheDocument();
  });

  it('A24: the search field takes at most what search accepts', async () => {
    renderKb({ world: chatWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search the wiki, materials and chats' });
    expect(input).toHaveAttribute('maxLength', '500');
  });

  it('A10: the summary of first launch has Back', async () => {
    const user = userEvent.setup();
    renderKb({ world: unconfiguredWorld(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    for (let i = 0; i < 3; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByRole('heading', { name: 'Where should the library live?' })).toBeInTheDocument();
  });
});
