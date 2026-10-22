import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { unconfiguredWorld } from '../test/fakeBridge';
import { syncSpeechConsent } from '../test/fakeKb';

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

describe('Live settings (package 2)', () => {
  it('health problems put a dot on the gear and the section, and a plate with what still works', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
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
    const { fake } = renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const codex = row(dialog, 'Codex');
    expect(await within(codex).findByText(/Connected · 1\.0\.0/)).toBeInTheDocument();
    const hermes = row(dialog, 'Hermes Agent');
    expect(within(hermes).getByText('Not installed')).toBeInTheDocument();
    expect(within(hermes).getByRole('note')).toHaveTextContent('Nothing starts until you press Check.');
    expect(within(hermes).getByRole('note')).not.toHaveTextContent(/GB|download|prepar/i);
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
    const state = chatWorld();
    state.decisions.provider = 'off';
    state.decisions.cloud_consent = false;
    const { fake } = renderKb({ world: state });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    const def = row(dialog, 'Default agent');
    await waitFor(() => expect(within(def).getByRole('radio', { name: 'Claude Code' })).toBeChecked());
    await user.click(within(def).getByRole('radio', { name: 'Hermes Agent (not connected)' }));
    expect(within(def).getByRole('alert')).toHaveTextContent('isn’t connected');
    await user.click(within(def).getByRole('radio', { name: 'Codex' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/agents/default', body: { engine: 'codex' } })));
    expect(row(dialog, 'Chat model')).toHaveTextContent('GPT-5.6-luna');
    expect(row(dialog, 'Chat model').querySelector('.kb-srow__control [data-engine="codex"]')).not.toBeNull();

    // Models screen v2: the wiki model is one picker like the message field's.
    await user.click(within(row(dialog, 'Wiki model')).getByRole('button', { name: /^Wiki model:/ }));
    const menu = await screen.findByRole('menu', { name: 'Wiki model' });
    await user.click(within(within(menu).getByRole('group', { name: 'Claude Code' })).getByRole('menuitemradio', { name: 'Opus 5.5' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/wiki',
      body: { wiki_engine: 'claude_code', wiki_model: 'claude-opus-5-5', wiki_effort: 'medium' } })));

    await user.click(within(row(dialog, 'Wiki decisions')).getByRole('radio', { name: 'OpenRouter · Jev' }));
    const consent = await screen.findByRole('dialog', { name: 'Send decision questions to OpenRouter?' });
    expect(fake.calls.some((c) => c.path === '/kb/decisions/provider')).toBe(false);
    await user.click(within(consent).getByRole('button', { name: 'Allow and use' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/decisions/provider', body: { provider: 'openrouter_jev', cloud_consent: true } })));
    expect(dialog).toHaveTextContent('never switches to another on its own');
  });

  it('a key saved in Accounts & keys counts at once in Models — no reopening Settings (0.3.1 fix)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.keys.providers = world.keys.providers.map((p) => (p.id === 'openrouter' ? { ...p, configured: false, valid: null, checked_at: null } : p));
    world.decisions = { ...world.decisions, provider: 'off', cloud_consent: false, openrouter_key: false };
    renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    await user.click(await within(row(dialog, 'Wiki decisions')).findByRole('radio', { name: 'OpenRouter · Jev' }));
    expect(within(row(dialog, 'Wiki decisions')).getByRole('alert')).toHaveTextContent('Add an OpenRouter key');
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const keyRow = await within(dialog).findByRole('group', { name: 'OpenRouter' });
    await user.click(within(keyRow).getByRole('button', { name: 'Add key…' }));
    await user.type(within(keyRow).getByLabelText('OpenRouter key'), 'sk-or-test');
    await user.click(within(keyRow).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(keyRow).getByText('Key saved')).toBeInTheDocument());
    await user.click(within(dialog).getByRole('button', { name: 'Models' }));
    await user.click(await within(row(dialog, 'Wiki decisions')).findByRole('radio', { name: 'OpenRouter · Jev' }));
    expect(await screen.findByRole('dialog', { name: 'Send decision questions to OpenRouter?' })).toBeInTheDocument();
  });

  it('Recording & speech and Wiki read and write the backend; background connections ask first; "Find now" starts a job', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
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

  it('"Find now" without a ready agent says so next to the button, starts nothing and leads to Accounts & keys (QA A13)', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    for (const a of world.agents.agents) a.state = 'not_installed';
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Wiki' }));
    const findRow = row(dialog, 'Find connections now');
    await user.click(within(findRow).getByRole('button', { name: 'Find now' }));
    expect(await within(findRow).findByRole('alert')).toHaveTextContent('Finding connections needs a connected agent.');
    expect(within(dialog).queryByText(/Started/)).not.toBeInTheDocument();
    expect(fake.world.jobs.some((j) => j.kind === 'connections')).toBe(false);
    await user.click(within(findRow).getByRole('button', { name: 'Open Accounts & keys' }));
    expect(within(dialog).getByRole('heading', { name: 'Accounts & keys', level: 3 })).toBeInTheDocument();
  });

  it('sending audio to Soniox: allowed only by the user (plate or switch), shown with what goes where, revocable', async () => {
    const user = userEvent.setup();
    const state = chatWorld();
    state.speech.cloud_consent = false;
    syncSpeechConsent(state);
    const { fake } = renderKb({ world: state });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    const consent = row(dialog, 'Send audio to Soniox');
    const toggle = within(consent).getByRole('switch', { name: 'Send audio to Soniox' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(consent).toHaveTextContent('Audio of recordings, imports and dictation → Soniox (cloud speech recognition)');
    // The plate offers the consent as an explicit action.
    const plate = (await within(dialog).findByText('Sending audio to Soniox is off')).closest('.kb-banner') as HTMLElement;
    await user.click(within(plate).getByRole('button', { name: 'Allow sending audio to Soniox' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/settings/health/speech-soniox-consent/allow_soniox' })));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(within(dialog).queryByText('Sending audio to Soniox is off')).not.toBeInTheDocument();
    // Taking it back is one click; giving it again asks first and says what is sent where.
    await user.click(toggle);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/speech', body: { cloud_consent: false } })));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(await within(dialog).findByText('Sending audio to Soniox is off')).toBeInTheDocument();
    const puts = () => fake.calls.filter((c) => c.path === '/kb/settings/speech' && (c.body as Record<string, unknown> | undefined)?.cloud_consent === true);
    await user.click(toggle);
    const ask = await screen.findByRole('dialog', { name: 'Send audio to Soniox?' });
    expect(ask).toHaveTextContent('Soniox');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(puts()).toHaveLength(0);
    await user.click(toggle);
    await user.click(within(await screen.findByRole('dialog', { name: 'Send audio to Soniox?' })).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('Privacy shows where data goes from the backend; About shows the version and licences', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Privacy' }));
    await waitFor(() => expect(row(dialog, 'Soniox')).toHaveTextContent('Sound of recordings'));
    expect(row(dialog, 'OpenRouter')).toHaveTextContent('Short excerpts for wiki decisions');
    await user.click(within(dialog).getByRole('button', { name: 'About' }));
    expect(row(dialog, 'Version')).toHaveTextContent('SKAZ 0.3.0 · kb-dev');
    expect(within(dialog).getByRole('link', { name: 'lucide-react' })).toBeInTheDocument();
  });

  it('Hermes first check (X5): one Check button starts the check, no download wording', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const hermesAgent = world.agents.agents.find((a) => a.id === 'hermes')!;
    Object.assign(hermesAgent, { state: 'unavailable', installed: true, version: '0.21.5', action: 'first_check',
      reason: "SKAZ checks once that Hermes Agent runs with SKAZ's own Hermes folder before first use. Press Check when you're ready." });
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const hermes = row(dialog, 'Hermes Agent');
    expect(hermes).not.toHaveTextContent(/GB|Prepar/);
    // One "Check" (the first check); "look again" makes no sense before it ran.
    const checks = within(hermes).getAllByRole('button', { name: 'Check' });
    expect(checks).toHaveLength(1);
    await user.click(checks[0]!);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/install', body: { action: 'first_check' } })));
    expect(await within(hermes).findByRole('status')).toHaveTextContent('Checking…');
    expect(within(hermes).getByLabelText('Install log')).toHaveTextContent('Checking Hermes Agent…');
  });

  it('Hermes that asks for its own repair (H3): Repair runs it, never Update or Reinstall', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const hermesAgent = world.agents.agents.find((a) => a.id === 'hermes')!;
    Object.assign(hermesAgent, { state: 'unavailable', installed: true, version: null, action: 'repair',
      reason: "Hermes Agent has to set up its dependencies for SKAZ's own Hermes folder once (a download that can take a few minutes). Press Repair to start it." });
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const hermes = row(dialog, 'Hermes Agent');
    expect(within(hermes).queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    await user.click(within(hermes).getByRole('button', { name: 'Repair' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/install', body: { action: 'repair' } })));
    expect(await within(hermes).findByRole('status')).toHaveTextContent('Repairing…');
  });
});

describe('First launch, step "Agent" (v21)', () => {
  it('three cards with the real state; Hermes says it is checked once first; the summary is honest', async () => {
    const user = userEvent.setup();
    const state = unconfiguredWorld();
    state.agents.agents.find((a) => a.id === 'codex')!.state = 'signed_out';
    Object.assign(state.agents.agents.find((a) => a.id === 'codex')!, { action: 'login', reason: 'Not signed in.' });
    const { fake } = renderKb({ world: state, prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    const cards = await within(dialog).findAllByRole('listitem');
    const byEngine = (e: string) => cards.find((c) => c.getAttribute('data-engine') === e)!;
    expect(byEngine('claude_code')).toHaveTextContent('Connected');
    expect(byEngine('hermes')).toHaveTextContent('Not installed');
    expect(within(byEngine('hermes')).getByRole('note')).toHaveTextContent("SKAZ's own Hermes folder");
    // Codex sign-in needs the ChatGPT privacy consent first.
    const codex = byEngine('codex');
    await user.click(within(codex).getByRole('checkbox'));
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    await user.click(within(codex).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ path: '/kb/agents/codex/login', body: { consent: true } })));
    // Accounts & keys v3: the sign-in page opens at once and SKAZ checks as soon as Codex says it is done.
    expect(opened).toHaveBeenCalledWith('https://auth.openai.com/authorize?fake=1', '_blank', 'noopener');
    expect(await within(codex).findByText('Signed in. Codex is connected.')).toBeInTheDocument();
    opened.mockRestore();

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
