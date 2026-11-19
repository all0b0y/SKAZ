import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonResponse } from '../../api/bridge';
import type { KbLinkCheck, KbLinkObservation } from '../../api/kb/types.gen';
import { contractFixtures } from '../api/fake/fixtures';
import { docWorld } from '../test/fakeBridge';
import { renderKb } from '../test/renderKb';

const checksPath = '/kb/freshness/link-checks';
const materialId = 'm-ce';
const observation: KbLinkObservation = {
  material_id: materialId,
  url: 'https://example.org/cross-entropy-explained',
  outcome: 'ok',
  reason: null,
  status_code: 200,
  checked_at: '2026-10-21T12:00:00Z',
  first_gone_at: null,
  confirm_after: null,
};

function deferredCheck() {
  let resolve!: (response: JsonResponse<KbLinkCheck>) => void;
  const response = new Promise<JsonResponse<KbLinkCheck>>((done) => { resolve = done; });
  return { response, resolve };
}

function checkResponse(id: string, state: KbLinkCheck['state'], observations: KbLinkObservation[] = []): JsonResponse<KbLinkCheck> {
  return { ok: true, status: 200, data: { ...contractFixtures.KbLinkCheck, id, state, observations } };
}

async function openMaterial(last: KbLinkObservation | null = null) {
  const { fake, services } = renderKb({ world: docWorld() });
  const request = fake.requestMock.getMockImplementation()!;
  fake.requestMock.mockImplementation(async (req) => {
    if (req.path === '/kb/materials/m-ce/freshness') {
      return { ok: true, status: 200, data: { marks: [], last_link_check: last } };
    }
    return request(req);
  });
  act(() => services.ui.getState().openDocument({ type: 'material', id: materialId }));
  const document = await screen.findByRole('complementary', { name: 'Document' });
  const button = await within(document).findByRole('button', { name: 'Check links' });
  return { fake, button };
}

afterEach(() => vi.useRealTimers());

describe('manual link checks in the material reader', () => {
  it.each(['header', 'retry card'] as const)('submits once while the %s request is pending', async (entry) => {
    const { fake, button } = await openMaterial(entry === 'retry card'
      ? { ...observation, outcome: 'could_not_check', reason: 'timeout', status_code: null }
      : null);
    const pending = deferredCheck();
    const request = fake.requestMock.getMockImplementation()!;
    fake.requestMock.mockImplementation((req) =>
      req.method === 'POST' && req.path === checksPath ? pending.response : request(req));

    await act(async () => {
      button.click();
      button.click();
    });
    const submissions = fake.requestMock.mock.calls.map(([req]) => req)
      .filter((req) => req.method === 'POST' && req.path === checksPath);
    expect.soft(submissions.map((req) => req.body)).toEqual([{ material_ids: [materialId] }]);
    expect.soft(button).toBeDisabled();
    expect.soft(button).toHaveAttribute('aria-busy', 'true');
    expect.soft(screen.queryByText('Checking the link…')).toBeInTheDocument();

    await act(async () => pending.resolve(checkResponse('check-a', 'done', [observation])));
    expect(screen.getByRole('button', { name: 'Check links' })).toBeEnabled();
    expect(screen.getByText(/The original link works/)).toBeInTheDocument();
  });

  it('waits for each poll and keeps the retry running when an earlier response settles', async () => {
    const { fake, button } = await openMaterial();
    const firstPoll = deferredCheck();
    const stalePoll = deferredCheck();
    const request = fake.requestMock.getMockImplementation()!;
    let starts = 0;
    const polls: string[] = [];
    fake.requestMock.mockImplementation(async (req) => {
      if (req.method === 'POST' && req.path === checksPath) {
        return checkResponse(++starts === 1 ? 'check-a' : 'check-b', 'queued');
      }
      if (req.method === 'GET' && req.path.startsWith(checksPath + '/')) {
        polls.push(req.path);
        if (req.path.endsWith('/check-a')) return polls.length === 1 ? firstPoll.response : stalePoll.response;
        return checkResponse('check-b', 'done', [{ ...observation, outcome: 'could_not_check', reason: 'http_403', status_code: 403 }]);
      }
      return request(req);
    });

    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect.soft(polls).toEqual([checksPath + '/check-a']);

    await act(async () => firstPoll.resolve({ ok: false, status: 503, detail: 'Lost the check status.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Lost the check status.');
    expect(button).toBeEnabled();
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByText('Checking the link…')).toBeInTheDocument();
    expect(button).toBeDisabled();

    await act(async () => stalePoll.resolve(checkResponse('check-a', 'done', [observation])));
    expect.soft(screen.queryByText('Checking the link…')).toBeInTheDocument();
    expect.soft(screen.queryByText(/The original link works/)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect.soft(polls).toEqual([checksPath + '/check-a', checksPath + '/check-b']);
    expect(screen.getByText(/The site refused the check/)).toBeInTheDocument();
    expect(screen.queryByText('Checking the link…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check links' })).toBeEnabled();
  });
});
