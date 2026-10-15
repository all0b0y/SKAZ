import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { b2State } from '../test/fakeB2';
import { notConfiguredState } from '../test/fakeBridge';

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

describe('Live settings (package 2)', () => {
  it('health problems put a dot on the gear and the section, and a plate with what still works', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    expect(await screen.findByTestId('settings-dot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings, needs attention' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    // The gear opens the section with the problem.
    expect(within(dialog).getByRole('heading', { name: 'Accounts & keys', level: 3 })).toBeInTheDocument();
    const titles = await within(dialog).findAllByText('Hermes Agent isn’t installed.');
    const banner = titles.map((t) => t.closest('.kb-banner')).find(Boolean) as HTMLElement;
    expect(banner).toHaveTextContent('Still works: Codex and Claude Code keep working.');
    expect(banner).toHaveTextContent('Stopped: Chats can’t use Hermes.');
    await user.click(within(banner).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/settings/health/hermes-missing/install' })));
    await waitFor(() => expect(screen.queryByTestId('settings-dot')).not.toBeInTheDocument());
  });

  it('Accounts & keys: real agent states; installing shows the log; a key is sent once and never shown', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const codex = row(dialog, 'Codex');
    expect(await within(codex).findByText(/Connected · 1\.0\.0/)).toBeInTheDocument();
    const hermes = row(dialog, 'Hermes Agent');
    expect(within(hermes).getByText('Not installed')).toBeInTheDocument();
    expect(within(hermes).getByRole('note')).toHaveTextContent('~1.5 GB');
    await user.click(within(hermes).getByRole('button', { name: 'Install' }));
    expect(await within(hermes).findByLabelText('Install log')).toHaveTextContent('Downloading Hermes Agent…');
    expect(within(hermes).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.click(within(hermes).getByRole('button', { name: 'Cancel' }));
    expect(await within(hermes).findByText('Cancelled')).toBeInTheDocument();

    const soniox = row(dialog, 'Soniox');
    expect(within(soniox).getByText('Key works')).toBeInTheDocument();
    await user.click(within(soniox).getByRole('button', { name: 'Replace…' }));
    const field = within(soniox).getByLabelText('Soniox key');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'sk-test-123');
    await user.click(within(soniox).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/keys/soniox', body: { key: 'sk-test-123' } })));
    expect(await within(soniox).findByText('Key saved')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('sk-test-123');
  });

  it('Models: default agent only among connected ones; wiki model; decisions to the cloud need explicit consent', async () => {
    const user = userEvent.setup();
    const state = b2State();
    state.decisions.provider = 'off';
    state.decisions.cloud_consent = false;
    const { fake } = renderKb({ b2: state });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    const def = row(dialog, 'Default agent');
    await waitFor(() => expect(within(def).getByRole('radio', { name: 'Claude Code' })).toBeChecked());
    await user.click(within(def).getByRole('radio', { name: 'Hermes Agent (not connected)' }));
    expect(within(def).getByRole('alert')).toHaveTextContent('isn’t connected');
    await user.click(within(def).getByRole('radio', { name: 'Codex' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/agents/default', body: { engine: 'codex' } })));
    expect(row(dialog, 'Chat')).toHaveTextContent('Codex: gpt-5.6-luna');

    await user.click(within(row(dialog, 'Wiki pages and notes')).getByRole('radio', { name: 'Claude Code' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/wiki', body: { wiki_engine: 'claude_code' } })));

    await user.click(within(row(dialog, 'Wiki decisions')).getByRole('radio', { name: 'OpenRouter · Jev' }));
    const consent = await screen.findByRole('dialog', { name: 'Send decision questions to OpenRouter?' });
    expect(fake.calls.some((c) => c.path === '/kb/decisions/provider')).toBe(false);
    await user.click(within(consent).getByRole('button', { name: 'Allow and use' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/decisions/provider', body: { provider: 'openrouter_jev', cloud_consent: true } })));
    expect(dialog).toHaveTextContent('never switches to another on its own');
  });

  it('Recording & speech and Wiki read and write the backend; background connections ask first; "Find now" starts a job', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    await waitFor(() => expect(within(row(dialog, 'Service')).getByRole('radio', { name: 'Soniox' })).toBeChecked());
    expect(within(row(dialog, 'Speech languages')).getByRole('button', { name: 'Russian' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(row(dialog, 'Speech languages')).getByRole('button', { name: 'German' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/speech', body: { languages: ['ru', 'en', 'de'] } })));
    await user.selectOptions(within(row(dialog, 'Default translation')).getByLabelText('Default translation'), '');
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/speech', body: { translate_by_default: false } })));

    await user.click(within(dialog).getByRole('button', { name: 'Wiki' }));
    const autoText = within(row(dialog, 'Pasted text → wiki')).getByRole('switch');
    await waitFor(() => expect(autoText).toHaveAttribute('aria-checked', 'false'));
    await user.click(autoText);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/wiki', body: { auto_add_text: true } })));
    await user.click(within(row(dialog, 'Find connections in the background')).getByRole('switch'));
    const ask = await screen.findByRole('dialog', { name: 'Look for connections in the background?' });
    expect(fake.calls.some((c) => (c.body as Record<string, unknown> | undefined)?.background_connections !== undefined)).toBe(false);
    await user.click(within(ask).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ body: { background_connections: true } })));
    await user.click(within(row(dialog, 'Find connections now')).getByRole('button', { name: 'Find now' }));
    expect(await within(dialog).findByText(/Found connections arrive as notifications/)).toBeInTheDocument();
  });

  it('Privacy shows where data goes from the backend; About shows the version and licences', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Privacy' }));
    await waitFor(() => expect(row(dialog, 'Soniox')).toHaveTextContent('Sound of recordings'));
    expect(row(dialog, 'OpenRouter')).toHaveTextContent('Short excerpts for wiki decisions');
    await user.click(within(dialog).getByRole('button', { name: 'About' }));
    expect(row(dialog, 'Version')).toHaveTextContent('SKAZ 0.3.0 · kb-dev');
    expect(within(dialog).getByRole('link', { name: 'lucide-react' })).toBeInTheDocument();
  });
});

describe('First launch, step "Agent" (v21)', () => {
  it('three cards with the real state; Hermes warns about preparing; the summary is honest', async () => {
    const user = userEvent.setup();
    const state = b2State();
    state.agents.agents.find((a) => a.id === 'codex')!.state = 'signed_out';
    Object.assign(state.agents.agents.find((a) => a.id === 'codex')!, { action: 'login', reason: 'Not signed in.' });
    const { fake } = renderKb({ state: notConfiguredState(), b2: state, prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    const cards = await within(dialog).findAllByRole('listitem');
    const byEngine = (e: string) => cards.find((c) => c.getAttribute('data-engine') === e)!;
    expect(byEngine('claude_code')).toHaveTextContent('Connected');
    expect(byEngine('hermes')).toHaveTextContent('Not installed');
    expect(within(byEngine('hermes')).getByRole('note')).toHaveTextContent('~1.5 GB');
    // Codex sign-in needs the ChatGPT privacy consent first.
    const codex = byEngine('codex');
    await user.click(within(codex).getByRole('checkbox'));
    await user.click(within(codex).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/agents/codex/login', body: { consent: true } })));
    expect(await within(codex).findByText(/sign-in opened in Terminal/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('heading', { name: 'How should speech be recognised?' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Soniox' })).toBeChecked());
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    const rows = within(dialog).getAllByRole('listitem').filter((li) => li.hasAttribute('data-tone'));
    expect(rows.map((r) => [r.textContent, r.getAttribute('data-tone')])).toEqual([
      ['Speech recognitionSoniox', 'ok'],
      ['Chat and wikiClaude Code 1.0.0', 'ok'],
      ['Library/Users/me/Documents/SKAZ', 'ok'],
    ]);
  });
});
