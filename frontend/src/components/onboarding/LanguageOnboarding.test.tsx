import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguageOnboarding } from './LanguageOnboarding';
import { useStore } from '../../state/store';
import type { Settings, SettingsUpdate } from '../../api/types';

// The recorder refuses to start without used_languages, so this modal is the
// only thing standing between a fresh install and that dead end. It must not
// offer an exit that leaves the list empty.

const settings = (over: Partial<Settings> = {}): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  contextual_local_enabled: false,
  supported_languages: ['ru', 'en', 'de', 'fr'],
  used_languages: null,
  ...over,
});

let saveSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveSettings = vi.fn(async (_update: SettingsUpdate) => undefined);
  useStore.setState({
    settings: settings(),
    saveSettings: saveSettings as unknown as (update: SettingsUpdate) => Promise<void>,
  });
});

describe('LanguageOnboarding', () => {
  it('cannot be confirmed until at least one language is chosen', async () => {
    render(<LanguageOnboarding />);
    expect(screen.getByRole('button', { name: /продолжить/i })).toBeDisabled();
  });

  it('offers no dismiss control, because an empty list blocks recording', () => {
    render(<LanguageOnboarding />);
    expect(screen.queryByRole('button', { name: /закрыть|позже|отмена|close/i })).toBeNull();
  });

  it('saves exactly the languages the user ticked', async () => {
    const user = userEvent.setup();
    render(<LanguageOnboarding />);

    await user.click(screen.getByRole('checkbox', { name: /немецкий/i }));
    await user.click(screen.getByRole('button', { name: /продолжить/i }));

    expect(saveSettings).toHaveBeenCalledWith({ used_languages: ['de'] });
  });

  it('applies a quick pick as the whole selection', async () => {
    const user = userEvent.setup();
    render(<LanguageOnboarding />);

    await user.click(screen.getByRole('button', { name: 'Русский + English' }));
    await user.click(screen.getByRole('button', { name: /продолжить/i }));

    expect(saveSettings).toHaveBeenCalledWith({ used_languages: ['ru', 'en'] });
  });

  it('orders languages by their displayed name, not by ISO code', () => {
    useStore.setState({ settings: settings({ supported_languages: ['sq', 'af', 'ru'] }) });
    render(<LanguageOnboarding />);
    const shown = screen.getAllByRole('checkbox').map((box) => box.closest('label')!.textContent);
    expect(shown).toEqual(['Албанский', 'Африкаанс', 'Русский']);
  });

  it('marks the quick pick that matches the current selection', async () => {
    const user = userEvent.setup();
    render(<LanguageOnboarding />);
    const pick = screen.getByRole('button', { name: 'Русский + English' });
    expect(pick).toHaveAttribute('aria-pressed', 'false');
    await user.click(pick);
    expect(pick).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters the list by typed name', async () => {
    const user = userEvent.setup();
    render(<LanguageOnboarding />);

    await user.type(screen.getByRole('searchbox', { name: /поиск языка/i }), 'англ');

    expect(screen.getByRole('checkbox', { name: /английский/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /немецкий/i })).toBeNull();
  });

  it('surfaces a save failure instead of closing silently', async () => {
    saveSettings.mockRejectedValueOnce(new Error('backend unreachable'));
    const user = userEvent.setup();
    render(<LanguageOnboarding />);

    await user.click(screen.getByRole('checkbox', { name: /русский/i }));
    await user.click(screen.getByRole('button', { name: /продолжить/i }));

    expect(await screen.findByText(/backend unreachable/i)).toBeInTheDocument();
  });
});
