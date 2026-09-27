import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProactiveCards } from './ProactiveCards';
import { useStore } from '../../state/store';
import type { BridgeRequest } from '../../api/bridge';
import type { Citation, ProactiveCard, ProactiveView, Settings } from '../../api/types';

// Authored card fixtures: they pin the card UI contract, not answer quality.

const cite = (text: string, start: number, labels: string[] = []): Citation => ({
  segment_id: `seg-${start}`, start_ms: start, end_ms: start + 3000, text, speaker: 1, labels,
});

const card = (over: Partial<ProactiveCard> = {}): ProactiveCard => ({
  id: 'card-1', session_id: 's1', status: 'answered', addressed: 'direct',
  question: 'Alex, when does the beta start?',
  question_citation: cite('Alex, when does the beta start?', 9000),
  context_citations: [cite('The beta starts on March 3 after the security review.', 0)],
  finished: true,
  context: 'The team discussed the launch schedule [P1].',
  answer: 'The beta starts on March 3 [P1].',
  missing: '', outside_recording: '',
  citations: [cite('The beta starts on March 3 after the security review.', 0, ['P1'])],
  notice: null, model: 'fixture', public_query: 'when does the beta start?', web: null,
  revision: 1, created_at: '', updated_at: '', finished_at: null, answered_at: null,
  timings: { detect_ms: 10, answer_ms: 100 },
  ...over,
});

const view = (cards: ProactiveCard[], over: Partial<ProactiveView> = {}): ProactiveView => ({
  enabled: true, live: true, session_enabled: true, sound: false, version: 1, cards, ...over,
});

const settings = (enabled: boolean): Settings => ({
  asr: { provider: 'local-whisper', model: 'small' },
  agent: { provider: 'openrouter', model: 'agent' },
  notes: { provider: 'openrouter', model: 'notes' },
  transcript_language: 'auto', output_language: 'en', cloud_consent: true, contextual_local_enabled: false,
  proactive: { enabled, aliases: ['Alex'], sound: false, model_consent: true },
});

let current: ProactiveView;
let calls: BridgeRequest[];
let pending: { id: string; chat_id: string; task_id: string; query: string }[];
const initial = useStore.getState();

beforeEach(() => {
  calls = [];
  pending = [];
  current = view([card()]);
  vi.spyOn(window.skaz, 'request').mockImplementation(async (req) => {
    calls.push(req);
    if (req.path === '/web-search/pending') return { ok: true, status: 200, data: { requests: pending } } as never;
    if (req.path.endsWith('/decision')) { pending = []; return { ok: true, status: 200, data: { accepted: true } } as never; }
    if (req.method === 'PUT' && req.path === '/sessions/s1/proactive') {
      current = { ...current, session_enabled: (req.body as { enabled: boolean }).enabled };
    }
    if (req.method === 'POST' && req.path.endsWith('/web')) {
      current = view([card({ web: { query: (req.body as { query: string }).query, status: 'awaiting_approval', results: [], error: null } })]);
      pending = [{ id: 'approval', chat_id: 'proactive-card-1', task_id: 'proactive-card-1', query: (req.body as { query: string }).query }];
    }
    return { ok: true, status: 200, data: current } as never;
  });
  useStore.setState({ activeSessionId: 's1', settings: settings(true), recorderState: 'recording' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.setState(initial, true);
  delete (window.skaz as { notifyProactive?: unknown }).notifyProactive;
});

it('renders nothing while the proactive assistant is disabled', async () => {
  useStore.setState({ settings: settings(false) });
  const { container } = render(<ProactiveCards onCite={() => {}} />);
  await act(async () => { await Promise.resolve(); });
  expect(container).toBeEmptyDOMElement();
  expect(calls).toEqual([]);
});

it('never shows cards for an imported recording', async () => {
  current = view([card()], { live: false });
  const { container } = render(<ProactiveCards onCite={() => {}} />);
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  expect(container).toBeEmptyDOMElement();
});

it('shows the question as heard, cited context and a cited draft answer', async () => {
  const onCite = vi.fn();
  render(<ProactiveCards onCite={onCite} />);
  const article = await screen.findByRole('article', { name: 'You’re being asked' });
  expect(within(article).getByText('“Alex, when does the beta start?”')).toBeInTheDocument();
  expect(within(article).getByRole('region', { name: 'Draft answer' })).toHaveTextContent('The beta starts on March 3');
  // The claim links to the transcript with its timestamp.
  const [source] = within(within(article).getByRole('region', { name: 'Draft answer' })).getAllByRole('button');
  fireEvent.click(source!);
  expect(onCite).toHaveBeenCalledWith(expect.objectContaining({ start_ms: 0, labels: ['P1'] }));
  fireEvent.click(within(article).getByText('“Alex, when does the beta start?”'));
  expect(onCite).toHaveBeenLastCalledWith(expect.objectContaining({ start_ms: 9000 }));
});

it('says so when it is unclear whether you were addressed, and states missing data', async () => {
  current = view([card({
    addressed: 'possible', status: 'no_answer', answer: '', context: '', citations: [],
    missing: 'The recording does not say when the beta starts.',
  })]);
  render(<ProactiveCards onCite={() => {}} />);
  const article = await screen.findByRole('article', { name: 'Possibly addressed to you' });
  expect(within(article).getByText('The recording does not say when the beta starts.')).toBeInTheDocument();
  // The question and its transcript context are still shown.
  expect(within(article).getByText('The beta starts on March 3 after the security review.')).toBeInTheDocument();
  expect(within(article).queryByRole('region', { name: 'Draft answer' })).not.toBeInTheDocument();
});

it('labels the assistant’s own knowledge as its addition', async () => {
  current = view([card({ outside_recording: 'Betas usually last a few weeks.' })]);
  render(<ProactiveCards onCite={() => {}} />);
  const addition = await screen.findByRole('region', { name: 'Assistant’s addition' });
  expect(addition).toHaveTextContent('not said in the session');
});

it('announces only new cards, with a content-free notification when not focused', async () => {
  const notify = vi.fn();
  (window.skaz as { notifyProactive?: (sound: boolean) => void }).notifyProactive = notify;
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  render(<ProactiveCards onCite={() => {}} />);
  await screen.findByRole('article');
  // The card that already existed when the session opened is not announced.
  expect(notify).not.toHaveBeenCalled();
  current = view([card({ id: 'card-2', question: 'Alex, can you share the slides?' }), card()], { sound: true });
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1), { timeout: 3000 });
  // Only the sound preference crosses to main; never any transcript text.
  expect(notify).toHaveBeenCalledWith(true);
  // The same card on later polls is not announced again (the answer updates in place).
  current = view([card({ id: 'card-2', revision: 2 }), card()], { sound: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(notify).toHaveBeenCalledTimes(1);
});

it('turns the assistant off for this session only', async () => {
  render(<ProactiveCards onCite={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off for this session' }));
  await screen.findByRole('button', { name: 'Turn on for this session' });
  expect(calls.find((c) => c.method === 'PUT')).toEqual({
    method: 'PUT', path: '/sessions/s1/proactive', body: { enabled: false },
  });
});

it('sends a web lookup only as the edited public query and after explicit approval', async () => {
  render(<ProactiveCards onCite={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Look up on the web…' }));
  const input = screen.getByLabelText('Public part of the question');
  expect(input).toHaveValue('when does the beta start?');
  fireEvent.change(input, { target: { value: 'typical beta programme length' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const approval = await screen.findByRole('group', { name: 'Approve web lookup' });
  expect(within(approval).getByText('typical beta programme length')).toBeInTheDocument();
  expect(calls.find((c) => c.path.endsWith('/web'))?.body).toEqual({ query: 'typical beta programme length' });
  expect(calls.some((c) => c.path.endsWith('/decision'))).toBe(false);
  const allow = within(approval).getByRole('button', { name: 'Allow this request' });
  await waitFor(() => expect(allow).not.toBeDisabled());
  fireEvent.click(allow);
  await waitFor(() => expect(calls.find((c) => c.path.endsWith('/decision'))?.body).toEqual({
    chat_id: 'proactive-card-1', query: 'typical beta programme length', approved: true,
  }));
});

it('shows web results in the same card as an addition, not as speech', async () => {
  current = view([card({ web: { query: 'beta length', status: 'completed', error: null,
    results: [{ title: 'Beta testing', url: 'https://example.com/beta', description: 'How betas work.' }] } })]);
  render(<ProactiveCards onCite={() => {}} />);
  const results = await screen.findByRole('region', { name: 'Web results' });
  expect(results).toHaveTextContent('assistant’s addition, not said in the session');
  expect(within(results).getByRole('link', { name: 'Beta testing' })).toHaveAttribute('href', 'https://example.com/beta');
  expect(screen.getAllByRole('article')).toHaveLength(1);
});
