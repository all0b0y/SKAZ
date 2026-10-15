import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { CaptureCallbacks, CaptureEngine } from './capture';

function engine() {
  let cb: CaptureCallbacks | null = null;
  let elapsed = 0;
  const e: CaptureEngine = {
    start: vi.fn(async (_s, c) => { cb = c; }),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    elapsedMs: () => elapsed,
    pending: () => ({ pending: 0, failed: 0 }),
  };
  return { e, level: (dbfs: number) => act(() => cb!.onLevel({ dbfs, peakDbfs: dbfs + 4, clipping: false })), at: (ms: number) => { elapsed = ms; }, fail: (m: string) => act(() => cb!.onFailure(m)) };
}

async function start() {
  const eng = engine();
  const user = userEvent.setup();
  const r = renderKb({ world: docWorld(), capture: () => eng.e });
  const bar = screen.getByTestId('titlebar');
  const record = await within(bar).findByRole('button', { name: 'Record' });
  await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
  return { ...r, eng, user, bar, record };
}

describe('Recording: "Record | Folder ▾", capsule, live panel (decisions 26–28)', () => {
  it('shows the last folder next to Record; the menu sets folder, microphone, mode and language', async () => {
    const { user, bar, fake } = await start();
    const folder = await within(bar).findByRole('button', { name: 'Recording folder and sound: Physics' });
    await user.click(folder);
    const menu = await screen.findByRole('dialog', { name: 'Recording settings' });
    await user.click(within(menu).getByRole('radio', { name: /Mathematics/ }));
    expect(within(bar).getByRole('button', { name: 'Recording folder and sound: Mathematics' })).toBeInTheDocument();
    expect(within(menu).getByRole('combobox', { name: 'Microphone' })).toHaveValue('');
    expect(within(menu).getByText('Not available on this Mac')).toBeInTheDocument();
    expect(within(menu).getByRole('combobox', { name: 'Translate into' })).toHaveValue('ru');
    await user.click(within(menu).getByRole('radio', { name: 'Transcription' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'PUT' && c.path === '/settings'
      && (c.body as Record<string, unknown>).native_recording_mode === 'transcription')).toBe(true));
    expect(within(menu).queryByRole('combobox', { name: 'Translate into' })).not.toBeInTheDocument();
  });

  it('Record turns into the red-timer capsule, opens the live panel and a chat about the recording', async () => {
    const { user, bar, record, fake, eng, services } = await start();
    const asked = vi.fn();
    window.addEventListener('kb:open-chat', asked as EventListener);
    await user.click(record);
    const capsule = await within(bar).findByRole('button', { name: /^Recording 00:00, folder Physics/ });
    expect(capsule).toHaveClass('kb-cap--rec');
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/kb/chats')?.body).toEqual({ recording_material_id: services.recording.getState().materialId });
    const live = await screen.findByRole('complementary', { name: 'Live recording' });
    expect(within(live).getByRole('heading', { level: 2, name: 'Recording 15 Oct, 09:00' })).toBeInTheDocument();
    // Bars: still in silence, the real level when there is sound — never animated by CSS.
    const bars = () => Array.from(capsule.querySelectorAll('.kb-lvl i')).map((i) => (i as HTMLElement).style.height);
    expect(bars()).toEqual(['4px', '4px', '4px']);
    eng.level(-8);
    expect(bars().some((h) => h !== '4px')).toBe(true);
    eng.level(-70);
    expect(bars()).toEqual(['4px', '4px', '4px']);
    window.removeEventListener('kb:open-chat', asked as EventListener);
  });

  it('clicking the capsule shows the row: pause, stop, original / translation / both', async () => {
    const { user, bar, record, eng, services } = await start();
    await user.click(record);
    eng.at(65_000);
    const capsule = await within(bar).findByRole('button', { name: /^Recording/ });
    await user.click(capsule);
    const row = await screen.findByRole('dialog', { name: 'Recording controls' });
    await user.click(within(row).getByRole('radio', { name: 'Both' }));
    expect(services.recording.getState().view).toBe('both');
    await user.click(within(row).getByRole('button', { name: 'Pause' }));
    expect(await within(bar).findByRole('button', { name: /^Paused/ })).toHaveClass('kb-cap--paused');
    expect(within(bar).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Resume' }));
    const again = await within(bar).findByRole('button', { name: /^Recording/ });
    await user.click(again);
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Stop' }));
    expect(await within(bar).findByRole('button', { name: 'Record' })).toBeInTheDocument();
    expect(eng.e.stop).toHaveBeenCalledTimes(1);
  });

  it('the live panel grows with final text, keeps the unstable tail grey, and follows the end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user, record } = await start();
      await user.click(record);
      const live = await screen.findByRole('complementary', { name: 'Live recording' });
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      // Recorded with translation: the panel shows the translation by default.
      expect(await within(live).findByText(/Итак, Больцман записал/)).toBeInTheDocument();
      expect(live.querySelector('.kb-tail')).toHaveTextContent('Получается, что cross-entropy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dropped speech connection is said in the live panel and the capsule while SKAZ reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user, bar, record, fake } = await start();
      await user.click(record);
      const live = await screen.findByRole('complementary', { name: 'Live recording' });
      fake.world.liveTranscription = 'reconnecting';
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      // Announced as a status, not an alert: recording goes on.
      expect(within(live).getAllByRole('status').some((el) => el.textContent?.includes('Reconnecting to Soniox…'))).toBe(true);
      expect(within(live).getByText(/Recording continues/)).toBeInTheDocument();
      const capsule = within(bar).getByRole('button', { name: /^Recording .*reconnecting to Soniox/ });
      expect(capsule).toHaveTextContent('Reconnecting…');
      fake.world.liveTranscription = 'streaming';
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(within(live).queryByText('Reconnecting to Soniox…')).not.toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: /^Recording/ })).not.toHaveTextContent('Reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognition stops: the panel says when, keeps the text, offers to continue; the capsule is gone', async () => {
    const { user, bar, record, eng } = await start();
    await user.click(record);
    const live = await screen.findByRole('complementary', { name: 'Live recording' });
    eng.at(761_000);
    eng.fail('The recognition service stopped answering.');
    const alert = await within(live).findByRole('alert');
    expect(alert).toHaveTextContent('Recognition stopped at 12:41.');
    expect(alert).toHaveTextContent('Recording won’t continue by itself.');
    expect(await within(bar).findByRole('button', { name: 'Record' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Continue recording' }));
    expect(await within(bar).findByRole('button', { name: /^Recording/ })).toBeInTheDocument();
  });

  it('a stopped recording offers "Continue recording" in its material; other materials do not', async () => {
    const { user, bar, record, services, fake } = await start();
    await user.click(record);
    const materialId = services.recording.getState().materialId!;
    await user.click(await within(bar).findByRole('button', { name: /^Recording/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Stop' }));
    await within(bar).findByRole('button', { name: 'Record' });
    // A recording made by SKAZ: its material asks the backend whether it may continue.
    act(() => services.ui.getState().openDocument({ type: 'material', id: materialId }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await user.click(await within(doc).findByRole('button', { name: 'Continue recording' }));
    expect(await within(bar).findByRole('button', { name: /^Recording/ })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === `/kb/recordings/${materialId}/resume`)).toHaveLength(1);
    expect(services.recording.getState()).toMatchObject({ phase: 'recording', materialId });
  });

  it('a recording with no recorder session behind it (seeded, imported) shows no "Continue recording"', async () => {
    const { services, fake } = await start();
    act(() => services.ui.getState().openDocument({ type: 'material', id: 'm-lec8' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    await within(doc).findByRole('heading', { level: 2 });
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'GET' && c.path === '/kb/recordings/m-lec8')).toBe(true));
    expect(within(doc).queryByRole('button', { name: 'Continue recording' })).not.toBeInTheDocument();
  });
});
