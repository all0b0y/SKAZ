import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSearchApproval } from './WebSearchApproval';
import { WebSearchSettings } from '../settings/WebSearchSettings';
import { useCodex } from '../../state/codex';
import type { BridgeRequest } from '../../api/bridge';

const initial = useCodex.getState();
const approval = { id: 'approval', chat_id: 'chat', task_id: 'task', query: '  approved "query" & exact  ' };
let calls: BridgeRequest[];
let waiting: boolean;
let configured: boolean;

beforeEach(() => {
  calls = []; waiting = true; configured = false;
  vi.spyOn(window.audiohelper, 'request').mockImplementation(async (req) => {
    calls.push(req);
    let data: unknown;
    if (req.path === '/web-search/pending') data = { requests: waiting ? [approval] : [] };
    else if (req.path.endsWith('/decision')) { waiting = false; data = { accepted: true }; }
    else {
      if (req.method === 'PUT') configured = true;
      data = { provider: 'brave', enabled: configured, available: configured, has_key: configured };
    }
    return { ok: true, data } as never;
  });
  useCodex.setState({ tasks: [{ id: 'task', chat_id: 'chat', status: 'running', kind: 'chat',
    session_ids: ['session'], question: 'PRIVATE', model: 'fixture', snapshot_id: null,
    answer: '', error: null, note_id: null, citations: [], activity: [] }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useCodex.setState(initial, true); });

it('shows the exact query but sends no decision until an explicit click', async () => {
  render(<WebSearchApproval />);
  const region = await screen.findByRole('region', { name: 'Web search approval' });
  expect(region.querySelector('pre')?.textContent).toBe(approval.query);
  expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Allow this request' }));
  await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([
    { method: 'POST', path: '/web-search/requests/approval/decision',
      body: { chat_id: 'chat', query: approval.query, approved: true } },
  ]));
  expect(JSON.stringify(calls)).not.toContain('PRIVATE');
});

it('declines without approving or rewriting', async () => {
  render(<WebSearchApproval />);
  fireEvent.click(await screen.findByRole('button', { name: 'Don’t search' }));
  await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
    chat_id: 'chat', query: approval.query, approved: false,
  }));
});

it('saves search credentials only by explicit action and clears the input', async () => {
  render(<WebSearchSettings />);
  const input = screen.getByLabelText('Brave Search API key');
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: 'fixture-key' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save search' }));
  await screen.findByText('Search settings saved.');
  expect(input).toHaveValue('');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true, api_key: 'fixture-key' });
  expect(localStorage.getItem('brave_search')).toBeNull();
});
