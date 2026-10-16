import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';
import { unconfiguredWorld, baseWorld, without } from '../test/fakeBridge';
import { summaryLines } from './Onboarding';

const currentStep = (dialog: HTMLElement) =>
  within(dialog).getByRole('list', { name: 'Setup steps' }).querySelector('[aria-current="step"]')?.getAttribute('data-step');

describe('First launch', () => {
  it('goes Languages → Agent → Speech → Library → Summary', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: without(unconfiguredWorld()), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    expect(currentStep(dialog)).toBe('lang');
    // Without reduced motion the illustration is animated (the still frame is tested separately).
    expect(dialog.querySelector('[data-art="lang"]')).toHaveAttribute('data-still', 'false');
    expect(within(dialog).getByRole('heading', { name: 'Which languages do you hear?' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(currentStep(dialog)).toBe('agent');
    expect(within(dialog).getByRole('heading', { name: 'Choose an agent' })).toBeInTheDocument();
    // This backend has no /kb/agents: the step says so honestly, with a retry, and offers no fake setup.
    expect(await within(dialog).findByText(/Agents couldn’t be checked/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(currentStep(dialog)).toBe('lang');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(currentStep(dialog)).toBe('speech');
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(currentStep(dialog)).toBe('library');
    expect(within(dialog).getByTestId('library-path')).toHaveTextContent('/Users/me/Documents/SKAZ');

    await user.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Ready to start' })).toBeInTheDocument());
    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/library', body: { path: null } }));

    const rows = within(dialog).getAllByRole('listitem').filter((li) => li.hasAttribute('data-tone'));
    expect(rows.map((r) => [r.textContent, r.getAttribute('data-tone')])).toEqual([
      ['Speech recognitionNot checked', 'warn'],
      ['Chat and wikiAgents couldn’t be checked — see Settings → Accounts & keys', 'warn'],
      ['Library/Users/me/Documents/SKAZ', 'ok'],
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Open SKAZ' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Welcome to SKAZ' })).not.toBeInTheDocument());
    expect(storedPrefs().onboardingDone).toBe(true);
  });

  it('languages and translation go to the backend speech settings — the ones recording and Settings use (QA A11)', async () => {
    const user = userEvent.setup();
    const world = unconfiguredWorld();
    Object.assign(world.speech, { languages: [], translate_by_default: false });
    const { fake } = renderKb({ world, prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    const chips = within(dialog).getAllByRole('group', { name: 'Which languages do you hear?' }).at(-1)!;
    await user.click(await within(chips).findByRole('button', { name: 'English' }));
    await waitFor(() => expect(within(chips).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true'));
    await user.click(within(chips).getByRole('button', { name: 'Russian' }));
    await user.selectOptions(within(dialog).getByLabelText('Default translation'), 'ru');
    await waitFor(() => expect(fake.world.speech).toMatchObject({ languages: ['en', 'ru'], translate_by_default: true, translation_language: 'ru' }));
    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/speech', body: { languages: ['en', 'ru'] } }));
    // Nothing of it is kept on the renderer side only.
    expect(storedPrefs()).not.toHaveProperty('languages');
    expect(storedPrefs()).not.toHaveProperty('translateTo');
  });

  it('Soniox: the consent to send audio is asked on the speech step (QA A12)', async () => {
    const user = userEvent.setup();
    const world = unconfiguredWorld();
    world.speech.cloud_consent = false;
    const { fake } = renderKb({ world, prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(currentStep(dialog)).toBe('speech');
    const consent = await within(dialog).findByRole('switch', { name: 'Send audio to Soniox' });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    const ask = await screen.findByRole('dialog', { name: 'Send audio to Soniox?' });
    await user.click(within(ask).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(fake.world.speech.cloud_consent).toBe(true));
    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PUT', path: '/kb/settings/speech', body: { cloud_consent: true } }));
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Send audio to Soniox' })).toBeChecked());
  });

  it('on this computer: the model download is offered right on the speech step, with its size (QA A2)', async () => {
    const user = userEvent.setup();
    const world = unconfiguredWorld();
    world.speech.provider = 'local_whisper';
    const { fake } = renderKb({ world, prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(within(dialog).getByText('Not downloaded')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Download · about 1.6 GB' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/settings/health/speech-local-model/download' })));
    expect(await within(dialog).findByRole('progressbar', { name: 'Downloading the speech model' })).toBeInTheDocument();
  });

  it('⌘K and ⌘, do nothing while first launch is open (QA A32)', async () => {
    renderKb({ world: unconfiguredWorld(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Welcome to SKAZ' })).toBe(dialog);
  });

  it('choosing another folder sends that path; a refusal stays on the step in the backend’s words', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: unconfiguredWorld(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    for (let i = 0; i < 2; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await user.click(within(dialog).getByRole('button', { name: 'Change…' }));
    expect(within(dialog).getByTestId('library-path')).toHaveTextContent('/Users/me/Notes');
    fake.requestMock.mockImplementationOnce(async () => ({ ok: false, status: 409, detail: 'Choose a folder inside Documents.' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create library' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a folder inside Documents.');
    expect(currentStep(dialog)).toBe('library');
    await user.click(within(dialog).getByRole('button', { name: 'Create library' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    expect(fake.calls.filter((c) => c.path === '/kb/library' && c.method === 'POST').at(-1)!.body).toEqual({ path: '/Users/me/Notes' });
  });

  it('skipping the library is reported honestly: no check where nothing is ready', async () => {
    const user = userEvent.setup();
    renderKb({ world: without(unconfiguredWorld()), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    for (let i = 0; i < 3; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    const art = dialog.querySelector('[data-art="summary"]')!;
    expect(Array.from(art.querySelectorAll('[data-tone]')).map((g) => g.getAttribute('data-tone'))).toEqual(['warn', 'warn', 'warn']);
    expect(art.querySelectorAll('.kb-art__line--bold.is-warn')).toHaveLength(3);
  });

  it('a library that is already connected is not created again', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: baseWorld(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    for (let i = 0; i < 2; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(within(dialog).getByText('Connected')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/library')).toBe(false);
  });

  it('summary: Soniox with a working key but without the consent is not ready (QA A12)', () => {
    const keys = { providers: [{ id: 'soniox' as const, configured: true, checked_at: null, valid: true }] };
    const speech = (cloud_consent: boolean) => ({
      provider: 'soniox' as const, languages: ['en'], translate_by_default: false, translation_language: 'ru', cloud_consent,
      local_model: { model: 'm', state: 'missing' as const, progress: null, reason: null, size_bytes: null },
    });
    expect(summaryLines(null, null, { settings: speech(false), keys })[0]).toEqual({ label: 'Speech recognition', tone: 'warn', text: 'Soniox — sending audio isn’t allowed yet' });
    expect(summaryLines(null, null, { settings: speech(true), keys })[0]).toEqual({ label: 'Speech recognition', tone: 'ok', text: 'Soniox' });
  });

  it('summary lines follow only real states', () => {
    expect(summaryLines(null).map((l) => l.tone)).toEqual(['warn', 'warn', 'warn']);
    expect(summaryLines({ state: 'unavailable', root: '/x' })[2]!.tone).toBe('err');
    expect(summaryLines({ state: 'ready', root: '/x/SKAZ' })[2]).toEqual({ label: 'Library', tone: 'ok', text: '/x/SKAZ' });
  });
});
