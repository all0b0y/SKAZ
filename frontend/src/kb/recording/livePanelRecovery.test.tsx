import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';
import { docWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';
import type { CaptureCallbacks, CaptureEngine } from './capture';

const readError = 'The recording could not be read.';
const recognitionError = 'The recognition service stopped answering.';
const panel = () => within(screen.getByRole('complementary', { name: 'Live recording' }));
const readAlert = () => panel().findByText('Couldn’t open this recording.');

async function openRecording(rejectReads: () => boolean) {
  const user = userEvent.setup();
  let callbacks: CaptureCallbacks | undefined;
  const capture: CaptureEngine = {
    start: vi.fn(async (_params, next) => { callbacks = next; }),
    stop: vi.fn(async () => true),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    elapsedMs: () => 42_000,
    pending: () => ({ pending: 0, failed: 0 }),
  };
  const world = docWorld();
  world.liveOpen = '';
  world.settings.native_recording_mode = 'transcription';
  const { fake, services } = renderKb({ world, capture: () => capture });
  const answer = fake.requestMock.getMockImplementation()!;
  const reads: string[] = [];
  fake.requestMock.mockImplementation(async (request: BridgeRequest) => {
    const id = services.recording.getState().materialId;
    if (id && request.method === 'GET' && request.path === '/kb/materials/' + id) {
      reads.push(request.path);
      if (rejectReads()) return { ok: false, status: 503, detail: readError };
      const material = fake.world.materials.find((item) => item.id === id)!;
      if (!material.fragments.length) {
        material.fragments.push({
          ...world.materials.find((item) => item.id === 'm-lec8')!.fragments[0]!,
          id: id + '-saved', text: 'A saved sentence.', corrections: [],
        });
      }
    }
    return answer(request);
  });
  const bar = within(screen.getByTestId('titlebar'));
  const record = await bar.findByRole('button', { name: 'Record' });
  await waitFor(() => expect(record).not.toHaveAttribute('aria-disabled'));
  await user.click(record);
  await bar.findByRole('button', { name: /^Recording/ });
  const id = services.recording.getState().materialId!;
  const failRecognition = async () => {
    act(() => callbacks!.onFailure(recognitionError));
    await bar.findByRole('button', { name: 'Record' });
  };
  const recordingWrites = () => fake.requestMock.mock.calls.map(([request]) => request)
    .filter(({ method, path }) => method === 'POST' && (path === '/kb/recordings' || path.endsWith('/resume')))
    .map(({ path }) => path);

  return { user, services, fake, capture, id, reads, failRecognition, recordingWrites, bar };
}

describe('LivePanel recovery in the production shell', () => {
  it('reports a failed initial read and retries the same material until it opens', async () => {
    let unavailable = true;
    const { user, capture, id, reads, recordingWrites } = await openRecording(() => unavailable);
    expect(await readAlert()).toBeVisible();
    expect(panel().getByRole('alert')).toHaveTextContent(readError);
    expect(panel().queryByText('No text was recognised.')).toBeNull();
    const retry = panel().getByRole('button', { name: 'Try again' });
    await user.click(retry);
    expect(await readAlert()).toBeVisible();
    unavailable = false;
    await user.click(panel().getByRole('button', { name: 'Try again' }));
    expect(await panel().findByText('A saved sentence.')).toBeVisible();
    expect(panel().queryByRole('alert')).toBeNull();
    expect(reads).toEqual(Array(3).fill('/kb/materials/' + id));
    expect(recordingWrites()).toEqual(['/kb/recordings']);
    expect(capture.start).toHaveBeenCalledTimes(1);
  });

  it('offers explicit Continue for the stopped recording while its material remains unreadable', async () => {
    const { user, capture, id, reads, failRecognition, recordingWrites, bar } = await openRecording(() => true);
    await waitFor(() => expect(reads).toEqual(['/kb/materials/' + id]));
    await failRecognition();
    const resume = await panel().findByRole('button', { name: 'Continue recording' });
    expect(resume.closest('[role="alert"]')).toHaveTextContent('Recognition stopped at 00:42.');
    expect(resume.closest('[role="alert"]')).toHaveTextContent(recognitionError);
    expect(await readAlert()).toBeVisible();
    expect(reads).toHaveLength(1);
    await user.click(panel().getByRole('button', { name: 'Try again' }));
    expect(await readAlert()).toBeVisible();
    expect(reads).toEqual(Array(2).fill('/kb/materials/' + id));
    expect(recordingWrites()).toEqual(['/kb/recordings']);
    expect(capture.start).toHaveBeenCalledTimes(1);
    await user.click(resume);
    await bar.findByRole('button', { name: /^Recording/ });
    expect(capture.start).toHaveBeenCalledTimes(2);
    expect(recordingWrites()).toEqual(['/kb/recordings', '/kb/recordings/' + id + '/resume']);
  });

  it('keeps loaded text and Continue when the end-of-recording refresh fails', async () => {
    let unavailable = false;
    const { id, reads, failRecognition } = await openRecording(() => unavailable);
    expect(await panel().findByText('A saved sentence.')).toBeVisible();
    unavailable = true;
    await failRecognition();
    await waitFor(() => expect(reads).toEqual(Array(2).fill('/kb/materials/' + id)));
    expect(panel().getByText('A saved sentence.')).toBeVisible();
    expect(panel().getByRole('button', { name: 'Continue recording' })).toBeEnabled();
    expect(panel().queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows a refused Continue and leaves capture stopped when consent is required', async () => {
    const { user, fake, capture, id, failRecognition, recordingWrites } = await openRecording(() => true);
    await failRecognition();
    const answer = fake.requestMock.getMockImplementation()!;
    const resumePath = '/kb/recordings/' + id + '/resume';
    const detail = 'Permission to send audio for recognition is required.';
    fake.requestMock.mockImplementation(async (request) => {
      if (request.method === 'POST' && request.path === resumePath) {
        return { ok: false, status: 403, code: 'consent_required', detail };
      }
      return answer(request);
    });

    await user.click(await panel().findByRole('button', { name: 'Continue recording' }));
    const refused = await screen.findByRole('dialog', { name: 'Recording didn’t continue' });
    expect(refused).toHaveTextContent(detail);
    expect(panel().getByRole('button', { name: 'Continue recording' })).toBeEnabled();
    expect(panel().getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(recordingWrites()).toEqual(['/kb/recordings', resumePath]);
    expect(capture.start).toHaveBeenCalledTimes(1);
  });

  it('does not show a failure for a different recording viewed in the same panel', async () => {
    const { services, failRecognition, recordingWrites } = await openRecording(() => true);
    await failRecognition();
    act(() => services.ui.getState().openLive('m-lec8'));
    expect(await panel().findByRole('heading', { name: 'Lecture 8 — entropy' })).toBeVisible();
    expect(panel().queryByRole('alert')).toBeNull();
    expect(panel().queryByRole('button', { name: 'Continue recording' })).toBeNull();
    expect(recordingWrites()).toEqual(['/kb/recordings']);
  });

  it('ignores a Continue click if the store has switched recordings before the panel rerenders', async () => {
    const { services, failRecognition, recordingWrites, capture } = await openRecording(() => false);
    await failRecognition();
    const resume = await panel().findByRole('button', { name: 'Continue recording' });
    await act(async () => {
      const failure = services.recording.getState().failure!;
      const materialId = 'other-recording';
      services.recording.setState({ materialId, failure: { ...failure, materialId } });
      resume.click();
    });
    expect(recordingWrites()).toEqual(['/kb/recordings']);
    expect(capture.start).toHaveBeenCalledTimes(1);
  });
});

it('keeps live fragments until detail covers them and retries a late failure without resuming capture', async () => {
  const { user, services, fake, capture, id, reads, failRecognition, recordingWrites } = await openRecording(() => false);
  expect(await panel().findByText('A saved sentence.')).toBeVisible();
  const material = fake.world.materials.find((item) => item.id === id)!;
  const final = { ...material.fragments[0]!, seg: 2, id: id + '-final', text: 'A live final sentence.' };
  const answer = fake.requestMock.getMockImplementation()!;
  let available = false;
  fake.requestMock.mockImplementation(async (request) => {
    if (!available && request.method === 'GET' && request.path === '/kb/materials/' + id) {
      reads.push(request.path);
      return { ok: false, status: 503, detail: 'Synthetic final read failure.' };
    }
    return answer(request);
  });
  act(() => services.recording.setState({
    liveFragments: [final, final],
    live: { material_id: id, after_seg: 2, stream: 'streaming', monologues: [], partial: null },
  }));
  expect(panel().getAllByText(final.text)).toHaveLength(1);

  await failRecognition();
  const retry = await panel().findByRole('button', { name: 'Try again' });
  expect(panel().getByText('Synthetic final read failure.')).toBeVisible();
  expect(panel().getByText(final.text)).toBeVisible();
  expect(reads).toEqual(Array(2).fill('/kb/materials/' + id));

  available = true;
  retry.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(reads).toHaveLength(3));
  expect(panel().getAllByText(final.text)).toHaveLength(1);
  expect(panel().getByRole('button', { name: 'Try again' })).toBeVisible();
  material.fragments.push({ ...final, text: 'The authoritative final sentence.' });
  await user.click(panel().getByRole('button', { name: 'Try again' }));
  expect(await panel().findByText('The authoritative final sentence.')).toBeVisible();
  expect(panel().queryByText(final.text)).toBeNull();
  expect(panel().queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(panel().getByRole('button', { name: 'Continue recording' })).toBeEnabled();
  expect(reads).toEqual(Array(4).fill('/kb/materials/' + id));
  expect(capture.start).toHaveBeenCalledTimes(1);
  expect(recordingWrites()).toEqual(['/kb/recordings']);
});

it('shares an in-flight catch-up at Stop and discards its reply when the same material gets a new session', async () => {
  const { services, fake, capture, id, reads, failRecognition, recordingWrites } = await openRecording(() => false);
  expect(await panel().findByText('A saved sentence.')).toBeVisible();
  const detail = fake.world.materials.find((item) => item.id === id)!;
  const final = { ...detail.fragments[0]!, seg: 2, id: id + '-old', text: 'Other session final sentence.' };
  const answer = fake.requestMock.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  fake.requestMock.mockImplementation(async (request) => {
    if (request.method === 'GET' && request.path === '/kb/materials/' + id && reads.length === 1) {
      reads.push(request.path);
      await gate;
      return { ok: true, status: 200, data: { ...detail, title: 'Late reply from the first session' } };
    }
    return answer(request);
  });
  act(() => services.recording.setState({
    liveFragments: [final],
    live: { material_id: id, after_seg: 3, stream: 'streaming', monologues: [], partial: null },
  }));
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(panel().getByText(final.text)).toBeVisible();
  await failRecognition();
  expect(reads).toHaveLength(2);
  const oldContinue = panel().getByRole('button', { name: 'Continue recording' });
  act(() => {
    services.recording.setState({ sessionId: 'synthetic-new-session', live: null, liveFragments: [] });
    oldContinue.click();
    services.recording.setState({ failure: null });
  });
  await waitFor(() => expect(reads).toHaveLength(3));
  await act(async () => { finish(); });
  expect(await panel().findByText('A saved sentence.')).toBeVisible();
  expect(panel().queryByText(final.text)).toBeNull();
  expect(panel().queryByText('Late reply from the first session')).toBeNull();
  expect(panel().queryByRole('button', { name: 'Continue recording' })).toBeNull();
  expect(capture.start).toHaveBeenCalledTimes(1);
  expect(recordingWrites()).toEqual(['/kb/recordings']);
});

it('keeps final fragments with their material when the active recording changes', async () => {
  const { services, fake, id } = await openRecording(() => false);
  expect(await panel().findByText('A saved sentence.')).toBeVisible();
  const base = fake.world.materials.find((material) => material.id === id)!.fragments[0]!;
  const own = { ...base, seg: 2, id: id + '-final', text: 'A final sentence for the open material.' };
  const other = { ...base, seg: 6, id: 'm-lec8-final', text: 'A final sentence for the other material.' };
  act(() => services.recording.setState({
    liveFragments: [own],
    live: { material_id: id, after_seg: 2, stream: 'streaming', monologues: [], partial: null },
  }));
  expect(panel().getByText(own.text)).toBeVisible();
  act(() => services.recording.setState({
    phase: 'idle', materialId: 'm-lec8', sessionId: 'other-synthetic-session',
    liveFragments: [other],
    live: { material_id: 'm-lec8', after_seg: 6, stream: 'streaming', monologues: [], partial: null },
  }));
  expect(panel().getByText(own.text)).toBeVisible();
  expect(panel().queryByText(other.text)).toBeNull();
  act(() => services.ui.getState().openLive('m-lec8'));
  expect(await panel().findByText(other.text)).toBeVisible();
  expect(panel().queryByText(own.text)).toBeNull();
});
