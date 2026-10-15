import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb, storedPrefs } from '../test/renderKb';
import { notConfiguredState, readyState } from '../test/fakeBridge';
import { summaryLines } from './Onboarding';

const currentStep = (dialog: HTMLElement) =>
  within(dialog).getByRole('list', { name: 'Setup steps' }).querySelector('[aria-current="step"]')?.getAttribute('data-step');

describe('First launch', () => {
  it('goes Languages → Agent → Speech → Library → Summary; languages are saved', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ state: notConfiguredState(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    expect(currentStep(dialog)).toBe('lang');
    // Without reduced motion the illustration is animated (the still frame is tested separately).
    expect(dialog.querySelector('[data-art="lang"]')).toHaveAttribute('data-still', 'false');
    expect(within(dialog).getByRole('heading', { name: 'Which languages do you hear?' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Russian' }));
    await user.click(within(dialog).getByRole('button', { name: 'English' }));
    expect(within(dialog).getByRole('button', { name: 'Russian' })).toHaveAttribute('aria-pressed', 'true');
    await user.selectOptions(within(dialog).getByLabelText('Default translation'), 'ru');
    expect(storedPrefs()).toMatchObject({ languages: ['ru', 'en'], translateTo: 'ru' });

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

  it('choosing another folder sends that path; a refusal stays on the step in the backend’s words', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ state: notConfiguredState(), prefs: { onboardingDone: false } });
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
    renderKb({ state: notConfiguredState(), prefs: { onboardingDone: false } });
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
    const { fake } = renderKb({ state: readyState(), prefs: { onboardingDone: false } });
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to SKAZ' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    for (let i = 0; i < 2; i += 1) await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    expect(within(dialog).getByText('Connected')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await within(dialog).findByRole('heading', { name: 'Ready to start' });
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/library')).toBe(false);
  });

  it('summary lines follow only real states', () => {
    expect(summaryLines(null).map((l) => l.tone)).toEqual(['warn', 'warn', 'warn']);
    expect(summaryLines({ state: 'unavailable', root: '/x' })[2]!.tone).toBe('err');
    expect(summaryLines({ state: 'ready', root: '/x/SKAZ' })[2]).toEqual({ label: 'Library', tone: 'ok', text: '/x/SKAZ' });
  });
});
