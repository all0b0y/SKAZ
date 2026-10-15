import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import type { CaptureCallbacks, CaptureEngine } from './capture';
import { SystemAudioUnavailable } from '../../audio/recorder';

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

  it('a quick hover then click keeps the control row open (no stale state closes it)', async () => {
    const { user, bar, record } = await start();
    await user.click(record);
    const capsule = await within(bar).findByRole('button', { name: /^Recording/ });
    const wrap = within(bar).getByTestId('record-capsule');
    // Both events before React re-renders: the click must see the row the hover just opened.
    act(() => {
      fireEvent.mouseEnter(wrap);
      fireEvent.click(capsule);
    });
    expect(await screen.findByRole('dialog', { name: 'Recording controls' })).toBeInTheDocument();
    expect(capsule).toHaveAttribute('aria-expanded', 'true');
    // The click pinned it: leaving the capsule no longer closes it.
    act(() => { fireEvent.mouseLeave(wrap); });
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByRole('dialog', { name: 'Recording controls' })).toBeInTheDocument();
    // A second click closes it.
    await user.click(capsule);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recording controls' })).not.toBeInTheDocument());
  });

  it('hover opens the row and leaving closes it; a click while it is open by hover pins it', async () => {
    const { user, bar, record } = await start();
    await user.click(record);
    const capsule = await within(bar).findByRole('button', { name: /^Recording/ });
    const wrap = within(bar).getByTestId('record-capsule');
    act(() => { fireEvent.mouseEnter(wrap); });
    expect(await screen.findByRole('dialog', { name: 'Recording controls' })).toBeInTheDocument();
    act(() => { fireEvent.mouseLeave(wrap); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recording controls' })).not.toBeInTheDocument());
    act(() => { fireEvent.mouseEnter(wrap); });
    await screen.findByRole('dialog', { name: 'Recording controls' });
    await user.click(capsule);
    act(() => { fireEvent.mouseLeave(wrap); });
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByRole('dialog', { name: 'Recording controls' })).toBeInTheDocument();
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

  it('continuous speech with no pause shows within one poll: final words stable, the rest grey, no gap at the handover', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user, record, fake, services } = await start();
      fake.world.settings.native_recording_mode = 'transcription';
      await services.recording.getState().loadOptions();
      fake.world.liveOpen = 'So the entropy of a closed system';
      await user.click(record);
      const live = await screen.findByRole('complementary', { name: 'Live recording' });
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      // No monologue closed (the material is empty), yet the words are there: stable, then grey.
      const finalWords = await within(live).findByText('So the entropy of a closed system');
      expect(finalWords).toHaveClass('kb-live-final');
      expect(live.querySelector('.kb-tail')).toHaveTextContent('So cross-entropy in machine learning is');
      expect(within(live).queryByText(/Listening/)).not.toBeInTheDocument();

      // The speaker keeps going and the monologue closes: the next live answer brings the closed
      // monologue as a fragment (asked with since_seg), the panel appends it without re-reading the
      // material. The closed words stay put — never gone, never twice.
      const id = services.recording.getState().materialId!;
      const material = fake.world.materials.find((m) => m.id === id)!;
      const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path === `/kb/materials/${id}`).length;
      const before = reads();
      material.fragments.push({ ...structuredClone(fake.world.materials[0]!.fragments[0]!), id: `${id}-seg-1`, seg: 1,
        text: 'So the entropy of a closed system never decreases.', speaker: 'Speaker 1', start_ms: 0, end_ms: 9_000 });
      fake.world.liveOpen = 'Why is that?';
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      await within(live).findByText('Why is that?');
      expect(live).toHaveTextContent('So the entropy of a closed system never decreases.');
      expect(live.textContent!.split('So the entropy of a closed system').length - 1).toBe(1);
      expect(reads()).toBe(before); // the tail came with the live answer, not the whole material
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

  it('a denied microphone says so and opens the microphone pane of System Settings', async () => {
    const { user, record, eng, fake } = await start();
    const open = vi.fn(async () => true);
    Object.assign(fake.bridge, { openSystemAudioSettings: open });
    vi.mocked(eng.e.start).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await user.click(record);
    const popover = await screen.findByRole('dialog', { name: 'Recording didn’t start' });
    expect(popover).toHaveTextContent('Microphone access was denied.');
    await user.click(within(popover).getByRole('button', { name: 'Open System Settings' }));
    expect(open).toHaveBeenCalledWith('microphone');
  });

  it('computer sound refused on Resume: the reason shows on the capsule with the screen & system audio pane', async () => {
    const { user, bar, record, eng, fake } = await start();
    const open = vi.fn(async () => false);
    Object.assign(fake.bridge, { openSystemAudioSettings: open });
    await user.click(record);
    await user.click(await within(bar).findByRole('button', { name: /^Recording/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Pause' }));
    await user.keyboard('{Escape}');
    vi.mocked(eng.e.resume).mockRejectedValueOnce(new SystemAudioUnavailable('denied'));
    await user.click(await within(bar).findByRole('button', { name: 'Resume' }));
    // Resuming is not starting: the window says what didn't happen.
    const popover = await screen.findByRole('dialog', { name: 'Recording didn’t resume' });
    expect(popover).toHaveTextContent('Recording didn’t resume');
    expect(popover).toHaveTextContent('Computer sound wasn’t allowed.');
    await user.click(within(popover).getByRole('button', { name: 'Open System Settings' }));
    expect(open).toHaveBeenCalledWith('system-audio');
    // main answered false (not macOS, or the pane didn't open): said, not swallowed.
    expect(await within(popover).findByText(/couldn’t be opened/)).toBeInTheDocument();
  });

  it('without the macOS bridge method there is no System Settings button, only the reason', async () => {
    const { user, record, eng } = await start();
    vi.mocked(eng.e.start).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await user.click(record);
    const popover = await screen.findByRole('dialog', { name: 'Recording didn’t start' });
    expect(popover).toHaveTextContent('Microphone access was denied.');
    expect(within(popover).queryByRole('button', { name: 'Open System Settings' })).not.toBeInTheDocument();
  });

  it('a stop whose last moment is unconfirmed says so in its own words, not "didn’t start"', async () => {
    const { user, bar, record, eng } = await start();
    Object.assign(eng.e, { incomplete: () => true });
    await user.click(record);
    await user.click(await within(bar).findByRole('button', { name: /^Recording/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Stop' }));
    const popover = await screen.findByRole('dialog', { name: 'The end of the recording isn’t confirmed' });
    expect(popover).toHaveTextContent('Everything received is saved.');
    expect(screen.queryByRole('dialog', { name: 'Recording didn’t start' })).not.toBeInTheDocument();
  });

  it('continuing a recording that fails to open says it didn’t continue', async () => {
    const { user, bar, record, eng, services } = await start();
    await user.click(record);
    const materialId = services.recording.getState().materialId!;
    await user.click(await within(bar).findByRole('button', { name: /^Recording/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Recording controls' })).getByRole('button', { name: 'Stop' }));
    await within(bar).findByRole('button', { name: 'Record' });
    vi.mocked(eng.e.start).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await act(async () => { await services.recording.getState().continueRecording(materialId); });
    const popover = await screen.findByRole('dialog', { name: 'Recording didn’t continue' });
    expect(popover).toHaveTextContent('Microphone access was denied.');
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
