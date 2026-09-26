import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPanel } from './SettingsPanel';
import { useStore } from '../../state/store';
import { stopCodexPolling, stopLoginWatch, useCodex } from '../../state/codex';
import { fakeCodex, type FakeCodex } from '../../test/codexFake';
import type { CodexSettings } from '../../api/codex';
import type { Settings, SettingsUpdate } from '../../api/types';

// Codex as the first provider tab of Assistant and of Notes, against the
// authored contract fixture. No real login, binary check or model call.

const initialCodex = useCodex.getState();
const originalBridge = window.audiohelper;
let fake: FakeCodex;
let saveSettings: ReturnType<typeof vi.fn>;

const OFF: CodexSettings = {
  assistant_enabled: false, notes_enabled: false, assistant_model: '', assistant_effort: '',
  notes_model: '', notes_effort: '', ask_before_large: true,
};
const CATALOG = [
  { id: 'fast', label: 'Fast', efforts: ['low'] },
  { id: 'deep', label: 'Deep', efforts: ['medium', 'high'] },
];

const legacySettings = (): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent-model' },
  notes: { provider: 'openrouter', model: 'notes-model' },
  transcript_language: 'auto',
  output_language: 'ru',
  cloud_consent: false,
  contextual_local_enabled: false,
  provider_has_api_key: { openrouter: true },
});

const start = async (patch: (f: FakeCodex) => void = () => undefined) => {
  useCodex.setState(initialCodex, true);
  fake = fakeCodex({ settings: { ...OFF } });
  fake.connection.models = CATALOG;
  patch(fake);
  Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true, value: fake.bridge });
  await act(() => useCodex.getState().load(null));
  render(<SettingsPanel onClose={() => {}} initialSection="agent" />);
};

/** Only these would start work, sign in or reach a model. */
// Reading the account on opening the Codex tab is an agreed free local check
// (CODEX-DMG-TRANSCRIPT-FIX-SPEC §2); model calls, logins and resumes are not.
const sideEffects = () => fake.calls.filter((c) => /messages|\/notes$|login|resume/.test(c.path));
const stateReads = () => fake.calls.filter((c) => c.path === '/codex/state').length;
const tabs = (label: string) => within(screen.getByRole('tablist', { name: `${label} provider` })).getAllByRole('tab');
const save = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Save changes' }));

beforeEach(() => {
  vi.restoreAllMocks();
  saveSettings = vi.fn(async (_update: SettingsUpdate) => undefined);
  useStore.setState({
    settings: legacySettings(),
    settingsError: null,
    saveSettings: saveSettings as unknown as (update: SettingsUpdate) => Promise<void>,
    loadModels: vi.fn(async () => []),
    recorderState: 'idle',
    devices: [],
    selectedDeviceId: null,
    enumerateDevices: vi.fn(async () => undefined),
    selectDevice: vi.fn(async () => undefined),
  });
});

afterEach(() => {
  stopCodexPolling();
  stopLoginWatch();
  vi.useRealTimers();
  Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true, value: originalBridge });
});

describe('Codex inside Assistant and Notes settings', () => {
  it('has no separate Codex section and puts Codex first in both provider rows', async () => {
    const user = userEvent.setup();
    await start();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).queryByRole('button', { name: 'Codex' })).toBeNull();
    const labels = tabs('Assistant').map((t) => t.textContent ?? '');
    expect(labels[0]).toBe('Codex');
    ['OpenRouter', 'OpenAI', 'Anthropic'].forEach((name, i) => expect(labels[i + 1]).toContain(name));
    await user.click(within(nav).getByRole('button', { name: 'Notes' }));
    expect(tabs('Notes')[0]).toHaveTextContent('Codex');
  });

  it('chooses Codex for Assistant and keeps Notes on OpenRouter, without any model call', async () => {
    const user = userEvent.setup();
    await start();
    await user.click(tabs('Assistant')[0]!);
    expect(tabs('Assistant')[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs('Assistant')[1]).toHaveAttribute('aria-selected', 'false');
    await user.selectOptions(screen.getByLabelText('Codex model'), 'deep');
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'high');
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(tabs('Notes')[1]).toHaveAttribute('aria-selected', 'true');
    await save(user);
    await waitFor(() => expect(fake.settings.assistant_enabled).toBe(true));
    expect(fake.settings).toEqual({ ...OFF, assistant_enabled: true, assistant_model: 'deep', assistant_effort: 'high' });
    // The legacy profiles are untouched: no provider or model switched behind the user's back.
    expect(saveSettings).toHaveBeenCalledWith({});
    expect(sideEffects()).toEqual([]);
  });

  it('chooses Codex for Notes while Assistant leaves Codex for its unchanged API profile', async () => {
    const user = userEvent.setup();
    await start((f) => { f.settings = { ...OFF, assistant_enabled: true, assistant_model: 'deep', assistant_effort: 'medium' }; });
    expect(tabs('Assistant')[0]).toHaveAttribute('aria-selected', 'true');
    await user.click(tabs('Assistant')[1]!); // OpenRouter, the stored API provider
    expect(tabs('Assistant')[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Codex model')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    await user.click(tabs('Notes')[0]!);
    await user.selectOptions(screen.getByLabelText('Codex model'), 'fast');
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'low');
    await save(user);
    await waitFor(() => expect(fake.settings.notes_enabled).toBe(true));
    expect(fake.settings).toMatchObject({
      assistant_enabled: false, assistant_model: 'deep', assistant_effort: 'medium',
      notes_enabled: true, notes_model: 'fast', notes_effort: 'low',
    });
    expect(saveSettings).toHaveBeenCalledWith({});
    expect(sideEffects()).toEqual([]);
  });

  it('offers only the returned catalog and never picks a model or effort on its own', async () => {
    const user = userEvent.setup();
    await start((f) => { f.settings = { ...OFF, assistant_enabled: true, assistant_model: 'retired', assistant_effort: 'high' }; });
    const model = screen.getByLabelText<HTMLSelectElement>('Codex model');
    expect([...model.options].map((o) => o.value)).toEqual(['', 'retired', 'fast', 'deep']);
    expect(model).toHaveValue('retired');
    expect(screen.getByText(/retired \(unavailable/)).toBeInTheDocument();
    await user.selectOptions(model, 'fast');
    // "high" is not offered by Fast: the effort is cleared, not replaced.
    const effort = screen.getByLabelText<HTMLSelectElement>('Reasoning effort');
    expect(effort).toHaveValue('');
    expect([...effort.options].map((o) => o.value)).toEqual(['', 'low']);
    expect(screen.getByText(/Codex will not start a task without a model and effort/)).toBeInTheDocument();
    // The effort control sits below the model control.
    expect(model.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows consent and the official login when signed out, then refreshes itself after sign-in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await start((f) => { f.connection = { ...f.connection, status: 'signed_out', models: [] }; });
    await user.click(tabs('Assistant')[0]!);
    expect(screen.getByText(/Zero data retention \(ZDR\) is not\s+guaranteed/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Codex model')).toBeNull();
    const checks = () => fake.calls.filter((c) => c.path === '/codex/connection/check').length;
    // Opening the tab re-reads the account once; nothing more happens on its own.
    await waitFor(() => expect(checks()).toBe(1));
    const login = screen.getByRole('button', { name: 'Sign in with ChatGPT' });
    expect(login).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I understand the terms/ }));
    await user.click(login);
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/authorize?fixture=1', '_blank', 'noopener');
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();

    // The browser completes sign-in; nobody presses "check".
    fake.connection = { ...fake.connection, status: 'connected', login: 'idle', models: CATALOG };
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByLabelText('Codex model')).toBeInTheDocument();
    expect(screen.getByLabelText('Reasoning effort')).toBeInTheDocument();
    // Sign-in is followed by reading state, never by another check request.
    expect(checks()).toBe(1);
    const reads = stateReads();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(stateReads()).toBe(reads);
  });

  it('offers a one-click re-login after an earlier consented sign-in and shows the Codex path', async () => {
    const user = userEvent.setup();
    await start((f) => {
      f.connection = { ...f.connection, status: 'signed_out', models: [], relogin_available: true, path: '/Users/me/.local/bin/codex' };
    });
    await user.click(tabs('Assistant')[0]!);
    expect(screen.getByTestId('codex-path')).toHaveTextContent('/Users/me/.local/bin/codex');
    expect(screen.queryByRole('checkbox', { name: /I understand the terms/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled();
  });

  it('reports a failed login once and stops watching', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await start((f) => { f.connection = { ...f.connection, status: 'signed_out', models: [] }; });
    await user.click(tabs('Assistant')[0]!);
    await user.click(screen.getByRole('checkbox', { name: /I understand the terms/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    fake.connection = { ...fake.connection, login: 'failed', error: 'Login did not complete' };
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in did not finish');
    const reads = stateReads();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(stateReads()).toBe(reads);
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeEnabled();
    // Signed in elsewhere later: an explicit re-check clears the stale failure.
    fake.connection = { ...fake.connection, status: 'connected', login: 'idle', models: CATALOG };
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByLabelText('Codex model')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives up on a login that never finishes instead of polling forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await start((f) => { f.connection = { ...f.connection, status: 'signed_out', models: [] }; });
    await user.click(tabs('Assistant')[0]!);
    await user.click(screen.getByRole('checkbox', { name: /I understand the terms/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await act(() => vi.advanceTimersByTimeAsync(320_000));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in timed out');
    const reads = stateReads();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(stateReads()).toBe(reads);
  });

  it('stops after repeated failures to read the login result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await start((f) => { f.connection = { ...f.connection, status: 'signed_out', models: [] }; });
    await user.click(tabs('Assistant')[0]!);
    await user.click(screen.getByRole('checkbox', { name: /I understand the terms/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    const request = fake.bridge.request as ReturnType<typeof vi.fn>;
    const real = request.getMockImplementation()!;
    request.mockImplementation(async (req: { path: string }) => (req.path === '/codex/state'
      ? { ok: false, status: 503, detail: 'backend busy' } : real(req)));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not get the sign-in result');
    const failures = request.mock.calls.filter(([req]) => (req as { path: string }).path === '/codex/state').length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(request.mock.calls.filter(([req]) => (req as { path: string }).path === '/codex/state')).toHaveLength(failures);
  });

  it('keeps the other purpose draft while signing in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await start((f) => { f.connection = { ...f.connection, status: 'signed_out', models: [] }; });
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    await user.click(tabs('Notes')[0]!);
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    await user.click(tabs('Assistant')[0]!);
    await user.click(screen.getByRole('checkbox', { name: /I understand the terms/ }));
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    fake.connection = { ...fake.connection, status: 'connected', login: 'idle', models: CATALOG };
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await user.selectOptions(await screen.findByLabelText('Codex model'), 'deep');
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(tabs('Notes')[0]).toHaveAttribute('aria-selected', 'true');
    await save(user);
    await waitFor(() => expect(fake.settings.notes_enabled).toBe(true));
    expect(fake.settings).toMatchObject({ assistant_enabled: true, assistant_model: 'deep', notes_enabled: true });
  });

  it('keeps the Codex draft when saving it fails', async () => {
    const user = userEvent.setup();
    await start();
    const request = fake.bridge.request as ReturnType<typeof vi.fn>;
    const real = request.getMockImplementation()!;
    request.mockImplementation(async (req: { path: string; method: string }) => (req.method === 'PUT' && req.path === '/codex/settings'
      ? { ok: false, status: 409, detail: 'Codex settings rejected' } : real(req)));
    await user.click(tabs('Assistant')[0]!);
    await save(user);
    expect(await screen.findByText('Codex settings rejected')).toBeInTheDocument();
    expect(tabs('Assistant')[0]).toHaveAttribute('aria-selected', 'true');
    expect(fake.settings.assistant_enabled).toBe(false);
  });

  it('is honest about a missing Codex and an unavailable web search', async () => {
    const user = userEvent.setup();
    await start((f) => { f.connection = { ...f.connection, status: 'missing', models: [] }; });
    await user.click(tabs('Assistant')[0]!);
    expect(screen.getByTestId('codex-connection')).toHaveTextContent('Codex was not found');
    expect(screen.getByText(/Installing Codex from SKAZ is not available yet/)).toBeInTheDocument();
    expect(screen.getByText(/Codex web search is off/)).toBeInTheDocument();
  });

  it('cannot choose Codex when this backend does not serve it', async () => {
    useCodex.setState(initialCodex, true);
    Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true, value: {
      ...originalBridge, request: vi.fn(async () => ({ ok: false, status: 404, detail: 'Not Found' })) } });
    await act(() => useCodex.getState().load(null));
    render(<SettingsPanel onClose={() => {}} initialSection="agent" />);
    expect(tabs('Assistant')[0]).toBeDisabled();
    expect(tabs('Assistant')[1]).toHaveAttribute('aria-selected', 'true');
  });
});
