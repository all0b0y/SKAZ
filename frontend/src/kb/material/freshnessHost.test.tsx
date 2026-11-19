import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonResponse } from '../../api/bridge';
import type { KbFreshnessMark, KbFreshnessMarks, KbLinkCheck, KbLinkObservation } from '../../api/kb/types.gen';
import { contractFixtures } from '../api/fake/fixtures';
import { docWorld } from '../test/fakeBridge';
import { renderKb } from '../test/renderKb';

const checksPath = '/kb/freshness/link-checks';
const materialId = 'm-ce';
const marksPath = '/kb/materials/m-ce/freshness';
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
const timedOut: KbLinkObservation = { ...observation, outcome: 'could_not_check', reason: 'timeout', status_code: null };
const confirmedGone: KbLinkObservation = {
  ...observation, outcome: 'confirmed_gone', reason: 'http_404', status_code: 404,
  checked_at: '2026-10-21T11:00:00Z', first_gone_at: '2026-10-20T11:00:00Z', confirm_after: '2026-10-21T11:00:00Z',
};
const versionMark: KbFreshnessMark = { ...contractFixtures.KbFreshnessMarks.marks[0]!, material_id: materialId };
const goneMark: KbFreshnessMark = {
  ...versionMark, id: 'mark-gone', kind: 'link_gone', reason: 'Original link is gone · your copy is kept',
  evidence_url: confirmedGone.url, checked_at: confirmedGone.checked_at, actions: ['keep_marked'], affected_statements: [],
  version: null, replacement_work_id: null, current_version: null, evidence_label: null,
  publication: { year: null, date: null, precision: 'unknown', origin: 'unknown', evidence_url: null },
};

function deferred<T>() {
  let resolve!: (response: JsonResponse<T>) => void;
  const response = new Promise<JsonResponse<T>>((done) => { resolve = done; });
  return { response, resolve };
}

function checkResponse(id: string, state: KbLinkCheck['state'], observations: KbLinkObservation[] = []): JsonResponse<KbLinkCheck> {
  return { ok: true, status: 200, data: { ...contractFixtures.KbLinkCheck, id, state, observations } };
}

function marksResponse(last: KbLinkObservation | null, marks: KbFreshnessMark[] = []): JsonResponse<KbFreshnessMarks> {
  return { ok: true, status: 200, data: { marks, last_link_check: last } };
}

async function openMaterial(last: KbLinkObservation | null = null, marks: KbFreshnessMark[] = []) {
  const { fake, services } = renderKb({ world: docWorld() });
  const request = fake.requestMock.getMockImplementation()!;
  fake.requestMock.mockImplementation(async (req) => {
    if (req.method === 'GET' && req.path === marksPath) return marksResponse(last, marks);
    return request(req);
  });
  act(() => services.ui.getState().openDocument({ type: 'material', id: materialId }));
  const reader = within(await screen.findByRole('complementary', { name: 'Document' }));
  const button = await reader.findByRole('button', { name: 'Check links' });
  return { fake, reader, button };
}

afterEach(() => vi.useRealTimers());

describe('manual link checks in the material reader', () => {
  it.each(['header', 'retry card'] as const)('submits once while the %s request is pending', async (entry) => {
    const { fake, button } = await openMaterial(entry === 'retry card' ? timedOut : null);
    const pending = deferred<KbLinkCheck>();
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
    const firstPoll = deferred<KbLinkCheck>();
    const stalePoll = deferred<KbLinkCheck>();
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

  it.each(['during the next submission', 'after recovery'] as const)('ignores an older marks response %s', async (timing) => {
    const { fake, reader, button } = await openMaterial();
    const stale = deferred<KbFreshnessMarks>();
    const recovery = deferred<KbLinkCheck>();
    const request = fake.requestMock.getMockImplementation()!;
    let starts = 0;
    let refreshes = 0;
    fake.requestMock.mockImplementation(async (req) => {
      if (req.method === 'POST' && req.path === checksPath) {
        expect(req.body).toEqual({ material_ids: [materialId] });
        return ++starts === 1 ? checkResponse('gone', 'done', [confirmedGone]) : recovery.response;
      }
      if (req.method === 'GET' && req.path === marksPath) {
        return ++refreshes === 1 ? stale.response : marksResponse(observation);
      }
      return request(req);
    });

    await act(async () => button.click());
    expect(refreshes).toBe(1);
    await act(async () => button.click());
    expect(starts).toBe(2);

    const releaseStale = () => act(async () => stale.resolve(marksResponse(confirmedGone, [goneMark])));
    if (timing === 'during the next submission') {
      await releaseStale();
      expect.soft(reader.queryByText(goneMark.reason)).not.toBeInTheDocument();
      expect(reader.getByText('Checking the link…')).toHaveAttribute('role', 'status');
    }
    await act(async () => recovery.resolve(checkResponse('recovered', 'done', [observation])));
    expect(refreshes).toBe(2);
    expect(reader.getByText(/The original link works/)).toBeVisible();
    if (timing === 'after recovery') await releaseStale();
    expect.soft(reader.queryByText(goneMark.reason)).not.toBeInTheDocument();
    expect(reader.queryByText(/The original link works/)).toBeVisible();
  });

  it.each(['unkept', 'kept'] as const)('reconciles the gone mark (%s) on recovery while the new marks read is pending', async (decision) => {
    const gone = { ...goneMark, kept_marked: decision === 'kept' };
    const { fake, reader, button } = await openMaterial(confirmedGone, [gone, versionMark]);
    const refresh = deferred<KbFreshnessMarks>();
    const request = fake.requestMock.getMockImplementation()!;
    fake.requestMock.mockImplementation(async (req) => {
      if (req.method === 'POST' && req.path === checksPath) return checkResponse('recovered', 'done', [observation]);
      if (req.method === 'GET' && req.path === marksPath) return refresh.response;
      return request(req);
    });

    expect(reader.getByText(gone.reason)).toBeVisible();
    await act(async () => button.click());
    expect.soft(reader.queryByText(gone.reason) !== null).toBe(gone.kept_marked);
    if (!gone.kept_marked) expect.soft(reader.queryByText(/The original link works/)).toBeVisible();
    expect(reader.getByText(versionMark.reason)).toBeVisible();
    await act(async () => refresh.resolve(marksResponse(observation, gone.kept_marked ? [gone, versionMark] : [versionMark])));
    expect(reader.queryByText(gone.reason) !== null).toBe(gone.kept_marked);
  });

  it('keeps the fresh refusal explanation and the same retry button through a pending submission', async () => {
    const { fake, reader, button } = await openMaterial();
    const oldRefresh = deferred<KbFreshnessMarks>();
    const retry = deferred<KbLinkCheck>();
    const request = fake.requestMock.getMockImplementation()!;
    let starts = 0;
    let refreshes = 0;
    fake.requestMock.mockImplementation(async (req) => {
      if (req.method === 'POST' && req.path === checksPath) {
        return ++starts === 1 ? checkResponse('timeout', 'done', [timedOut]) : retry.response;
      }
      if (req.method === 'GET' && req.path === marksPath) {
        return ++refreshes === 1 ? oldRefresh.response : marksResponse(observation);
      }
      return request(req);
    });

    await act(async () => button.click());
    expect(refreshes).toBe(1);
    const retryButton = reader.getByRole('button', { name: 'Check links' });
    const card = retryButton.closest<HTMLElement>('[data-mark-kind="could_not_check"]')!;
    const explanation = 'The site did not respond. Your source has not been marked as outdated.';
    expect(card).toHaveTextContent(explanation);
    await act(async () => {
      retryButton.click();
      retryButton.click();
    });
    expect(starts).toBe(2);
    expect(refreshes).toBe(1);
    expect.soft(reader.getByRole('button', { name: 'Check links' })).toBe(retryButton);
    expect.soft(card).toBeInTheDocument();
    expect.soft(within(card).getByRole('button', { name: 'Check links' })).toBeDisabled();
    expect.soft(retryButton).toHaveAttribute('aria-busy', 'true');
    expect.soft(reader.queryByText(explanation)).toBeVisible();
    expect(reader.getByText('Checking the link…')).toBeVisible();

    await act(async () => retry.resolve(checkResponse('recovered', 'done', [observation])));
    await act(async () => oldRefresh.resolve(marksResponse(timedOut)));
    expect(card).not.toBeInTheDocument();
    expect(reader.getByRole('button', { name: 'Check links' })).toBeEnabled();
    expect(reader.getByText(/The original link works/)).toBeVisible();
  });
});
