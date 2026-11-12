import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAreaMap, KbNotification, KbResearchTask } from '../../api/kb/types.gen';
import { createFakeKb } from '../api/fake';
import { scenes } from '../api/fake/scenes';
import { contractFixtures as f } from '../api/fake/fixtures';
import { createServices, KbServicesProvider } from '../state/context';
import { createFakeBridge } from '../test/fakeBridge';
import { chatWorld } from '../test/fixtures';
import { topicDraft } from './TopicEditor';
import { SidePanel } from '../shell/SidePanel';
import { ChatCenter } from '../shell/ChatCenter';
import { ChatView } from '../chat/ChatView';
import { bindResearchApi, ResearchPartView, ResearchTaskView } from './index';

const proposal = { title: 'AI agents', topics: [{ text: 'agent evaluation', source: 'proposed' as const }] };
const description = 'Найди новые методы оценки агентов для деловых коммуникаций';
const task = structuredClone(scenes.research_running.task);
const done: KbResearchTask = { ...task, run: { ...task.run, state: 'done', stop_reason: 'completed' } };
function setup(node?: React.ReactNode, tasks: KbResearchTask[] = []) {
  const fake = createFakeKb();
  fake.research.tasks = vi.fn(async () => ({ tasks, next_cursor: null }));
  fake.research.task = vi.fn(async (id) => tasks.find((t) => t.id === id) ?? task);
  fake.research.create = vi.fn(async (body) => ({ ...task, topics: body.topics ?? [], description: body.description }));
  fake.research.decide = vi.fn(async () => ({ ...f.KbResearchPermission, status: 'allowed' as const, task_id: task.id }));
  const base = createFakeBridge(chatWorld());
  const original = base.requestMock.getMockImplementation()!;
  const root: KbAreaMap = { ...f.KbAreaMap, areas: [{ ...f.KbArea, id: 'agents', name: 'AI agents', level: 'custom', parent_id: null }] };
  const child: KbAreaMap = { ...root, parent_id: 'agents', areas: [{ ...root.areas[0]!, id: 'evaluation', name: 'Evaluation', parent_id: 'agents' }] };
  base.requestMock.mockImplementation(async (req) => {
    if (req.path === '/kb/research/proposals') { base.calls.push(req); return { ok: true, status: 200, data: proposal }; }
    if (req.path.startsWith('/kb/explore/map')) return { ok: true, status: 200, data: req.query?.parent_id === 'agents' ? child : root };
    if (req.path.endsWith('/read') && req.path.startsWith('/kb/notifications/')) return { ok: true, status: 204, data: null };
    return original(req);
  });
  const services = createServices(base.bridge, localStorage, { capture: null });
  services.chats.setState({ list: base.world.chats, listLoad: 'ready' });
  const store = bindResearchApi(services.client, fake);
  const view = render(<KbServicesProvider services={services}>{node ?? <><SidePanel width={240} /><ChatCenter hidden={false} /></>}</KbServicesProvider>);
  return { ...view, services, store, fake, base };
}
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

async function newCard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New' }));
  await user.click(screen.getByRole('menuitem', { name: 'New research task' }));
  await user.type(screen.getByRole('textbox', { name: 'Describe what you want to find or learn' }), description);
  await user.click(screen.getByRole('button', { name: 'Suggest topics' }));
  return screen.findByRole('region', { name: 'Research topics' });
}

describe('EX2 X5 · editable research cards', () => {
  it('proposes from a Russian description before any run, then starts with exactly edited, typed and picked topics', async () => {
    const user = userEvent.setup();
    const { base, fake, store } = setup();
    const card = await newCard(user);
    expect(fake.research.create).not.toHaveBeenCalled();
    expect(base.calls.find((c) => c.path === '/kb/research/proposals')?.body).toEqual({ description, area_id: null });
    await user.clear(within(card).getByRole('textbox', { name: 'Topic 1' }));
    await user.type(within(card).getByRole('textbox', { name: 'Topic 1' }), 'agent reliability');
    await user.type(within(card).getByRole('textbox', { name: 'Add your own topic' }), 'business communication');
    await user.click(within(card).getByRole('button', { name: 'Add topic' }));
    await user.click(within(card).getByRole('button', { name: 'Pick from your topics' }));
    await user.click(await within(card).findByRole('button', { name: 'Open subtopics of AI agents' }));
    await user.click(await within(card).findByRole('button', { name: 'Pick Evaluation' }));
    expect(within(card).getByText('Will search: agent reliability · business communication · Evaluation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start research' }));
    expect(fake.research.create).toHaveBeenCalledWith({ description, area_id: null, topics: [
      { text: 'agent reliability', source: 'proposed', area_id: null },
      { text: 'business communication', source: 'typed', area_id: null },
      { text: 'Evaluation', source: 'picked', area_id: 'evaluation' },
    ] });
    expect(store.getState()).toMatchObject({ mode: 'task', activeTaskId: task.id });
    expect(await screen.findByRole('button', { name: task.title })).toHaveAttribute('aria-current', 'page');
  });

  it('requires 1–4 nonempty topics and does not silently lose a pending typed topic', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    const card = await newCard(user);
    await user.click(within(card).getByRole('button', { name: 'Remove topic 1' }));
    expect(screen.getByRole('button', { name: 'Start research' })).toBeDisabled();
    await user.type(within(card).getByRole('textbox', { name: 'Add your own topic' }), 'one');
    await user.click(screen.getByRole('button', { name: 'Start research' }));
    expect(fake.research.create).toHaveBeenCalledWith(expect.objectContaining({ topics: [{ text: 'one', source: 'typed', area_id: null }] }));
  });

  it('permission card sends the final list including a pending typed topic and keeps edits when its part refreshes', async () => {
    const user = userEvent.setup();
    const part = { ...f.KbResearchPermission, status: 'pending' as const, topics: ['AI agents'] };
    const { fake, rerender, services } = setup(<ResearchPartView chatId="c1" part={part} />);
    await user.clear(screen.getByRole('textbox', { name: 'Topic 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Topic 1' }), 'AI agent safety');
    rerender(<KbServicesProvider services={services}><ResearchPartView chatId="c1" part={{ ...part }} /></KbServicesProvider>);
    expect(screen.getByRole('textbox', { name: 'Topic 1' })).toHaveValue('AI agent safety');
    await user.type(screen.getByRole('textbox', { name: 'Add your own topic' }), 'harness');
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(fake.research.decide).toHaveBeenCalledWith(part.id, { decision: 'allow', topics: [
      { text: 'AI agent safety', source: 'proposed', area_id: null },
      { text: 'harness', source: 'typed', area_id: null },
    ] });
  });

  it('shows an honest proposal error and never starts a fallback run', async () => {
    const user = userEvent.setup();
    const { base, fake } = setup();
    const request = base.requestMock.getMockImplementation()!;
    base.requestMock.mockImplementation(async (req) => req.path === '/kb/research/proposals'
      ? { ok: false, status: 503, detail: 'Research is not ready', code: 'not_ready' } : request(req));
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('menuitem', { name: 'New research task' }));
    await user.type(screen.getByRole('textbox', { name: 'Describe what you want to find or learn' }), description);
    await user.click(screen.getByRole('button', { name: 'Suggest topics' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fake.research.create).not.toHaveBeenCalled();
  });
});

describe('EX2 X5 · Chats and Research rows', () => {
  it('keeps only + in the idle Chats header and removes the New chat row while preserving command-click selection', async () => {
    const user = userEvent.setup();
    setup();
    const side = screen.getByRole('region', { name: 'Chats' });
    expect(within(side).queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(within(side).queryByRole('button', { name: 'Select items' })).toBeNull();
    const first = within(side).getByRole('button', { name: /Why is there a logarithm/ });
    await user.keyboard('{Meta>}');
    await user.click(first);
    await user.keyboard('{/Meta}');
    expect(await within(side).findByRole('toolbar', { name: '1 selected' })).toBeInTheDocument();
  });

  it('renders a task once with the chat menu, working mark, and persistent collapse', async () => {
    const user = userEvent.setup();
    const { services, store, unmount } = setup(undefined, [task]);
    act(() => services.chats.setState({ list: [...services.chats.getState().list, { ...services.chats.getState().list[0]!, id: task.chat_id, title: task.title, research_task_id: task.id }] }));
    const section = await screen.findByRole('region', { name: 'Research tasks' });
    expect(screen.getAllByRole('button', { name: new RegExp(`^${task.title}`) })).toHaveLength(1);
    expect(within(section).getByRole('img', { name: 'answering' })).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: `More for “${task.title}”` }));
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(section).getByRole('button', { name: 'Research' }));
    expect(within(section).getByRole('button', { name: 'Research' })).toHaveAttribute('aria-expanded', 'false');
    unmount();
    const next = setup(undefined, [task]);
    const collapsed = await screen.findByRole('button', { name: 'Research' });
    expect(collapsed).toHaveAttribute('aria-expanded', 'false');
    act(() => next.store.getState().openTask(task.id));
    expect(screen.getByRole('button', { name: 'Research' })).toHaveAttribute('aria-expanded', 'true');
    expect(store.getState().mode).toBe('closed');
  });
});

function finishedNotification(id: string, taskId: string): KbNotification {
  return { id, kind: 'research_finished', title: 'Research finished', body: '', payload: { task_id: taskId },
    requires_action: false, created_at: task.updated_at, dismissed_at: null, seq: 1, actions: [], subject: null, resolved_at: null, resolution: null };
}
describe('EX2 X5 · read only when finished work is seen', () => {
  it('selectively reads the matching notification when a finished task is visible, even if the feed arrives later', async () => {
    const { services, base } = setup(<ResearchTaskView initialTask={done} />);
    act(() => services.notifications.setState({ items: [finishedNotification('mine', task.id), finishedNotification('other', 'different-task')], unread: 2, load: 'ready' }));
    await waitFor(() => expect(base.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/notifications/mine/read' })));
    expect(base.requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/kb/notifications/other/read' }));
    expect(base.requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/kb/notifications/read' }));
  });

  it('does not mark a hidden chat as read when its answer finishes', async () => {
    const { services, base } = setup(<ChatView hidden />);
    act(() => { services.chats.getState().open('c1'); services.chats.setState({ list: services.chats.getState().list.map((c) => c.id === 'c1' ? { ...c, unread: true } : c) }); });
    await waitFor(() => expect(services.chats.getState().chats.c1?.load).toBe('ready'));
    expect(base.requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/chats/c1/read' }));
  });
});


describe('EX2 X5 · visible research funnel', () => {
  it('shows found → fit → new and explains dropped works; It fits never starts a paid check', async () => {
    const user = userEvent.setup();
    const { base, fake } = setup(<ResearchTaskView initialTask={done} />);
    vi.spyOn(fake.research, 'resume');
    const request = base.requestMock.getMockImplementation()!;
    const dropped = { ...f.KbFunnelCandidate, candidate_id: 'dropped', outcome: 'not_fit', reason: 'Does not fit the card topics', overridden: false };
    base.requestMock.mockImplementation(async (req) => {
      if (req.path.endsWith('/candidates')) return { ok: true, status: 200, data: { items: [dropped], next_cursor: null } };
      if (req.path.endsWith('/dropped/fits')) return { ok: true, status: 200, data: { ...dropped, outcome: 'fits', overridden: true } };
      return request(req);
    });
    const c = done.run.counters;
    expect(screen.getByText(`${c.checked} found → ${c.on_topic} fit → ${c.new} new`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show considered works' }));
    expect(await screen.findByText(dropped.reason)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'It fits' }));
    expect(await screen.findByText('Fits · novelty not checked', { selector: 'span' })).toBeInTheDocument();
    expect(fake.research.resume).not.toHaveBeenCalled();
    expect(base.requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/kb/explore/runs' }));
  });
});


describe('EX2 X5 · boundary and lifecycle checks', () => {
  it('opens the newly allowed task in Research and keeps Deny available with no topics', async () => {
    const user = userEvent.setup();
    const part = { ...f.KbResearchPermission, status: 'pending' as const, topics: ['AI agents'] };
    const { store, services } = setup(<ResearchPartView chatId="c1" part={part} />);
    await user.click(screen.getByRole('button', { name: 'Remove topic 1' }));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
    await user.type(screen.getByRole('textbox', { name: 'Add your own topic' }), 'agent testing');
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(store.getState()).toMatchObject({ mode: 'task', activeTaskId: task.id });
    expect(services.prefs.getState().section).toBe('chats');
  });

  it('renames and deletes an active research chat through the shared menu, and a stale task page cannot restore it', async () => {
    const user = userEvent.setup();
    const { base, services, store } = setup(undefined, [task]);
    const chat = { ...base.world.chats[0]!, id: task.chat_id, title: task.title, research_task_id: task.id };
    base.world.chats.push(chat);
    act(() => services.chats.setState({ list: [...services.chats.getState().list, chat] }));
    await user.click(await screen.findByRole('button', { name: `More for “${task.title}”` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const name = await screen.findByRole('textbox', { name: 'Chat name' });
    await user.clear(name); await user.type(name, 'Renamed research{Enter}');
    await user.click(await screen.findByRole('button', { name: 'More for “Renamed research”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    expect(within(dialog).getByText(/Its findings stay in Explore/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(base.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: `/kb/chats/${task.chat_id}` }));
    await waitFor(() => expect(store.getState().tasks).toHaveLength(0));
    await act(async () => { await store.getState().loadTasks(); });
    expect(store.getState().tasks).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Renamed research/ })).toBeNull();
    expect(base.requestMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: `/kb/chats/${task.chat_id}` }));
  });

  it('waits for the finished task to become visible when the window was hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { base, services } = setup(<ResearchTaskView initialTask={done} />);
    act(() => services.notifications.setState({ items: [finishedNotification('hidden-finished', done.id)], unread: 1 }));
    expect(base.requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/kb/notifications/hidden-finished/read' }));
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(base.requestMock).toHaveBeenCalledWith(expect.objectContaining({ path: '/kb/notifications/hidden-finished/read' })));
  });

  it('shows the unread dot for a finished task outside the current view', async () => {
    const { services } = setup(undefined, [done]);
    act(() => services.chats.setState({ list: [...services.chats.getState().list, { ...services.chats.getState().list[0]!, id: done.chat_id, title: done.title, research_task_id: done.id, unread: true, state: 'idle' }] }));
    const section = await screen.findByRole('region', { name: 'Research tasks' });
    expect(within(section).getByRole('img', { name: 'new answer' })).toBeInTheDocument();
  });

  it('limits final topics by count, unicode length, blanks, and duplicates', () => {
    const typed = (text: string) => ({ text, source: 'typed' as const, area_id: null });
    expect(topicDraft([], '').problem).not.toBeNull();
    expect(topicDraft([typed('a'), typed('b'), typed('c'), typed('d')], '').problem).toBeNull();
    expect(topicDraft([typed('a'), typed('b'), typed('c'), typed('d')], 'e').problem).toBe('Keep up to 4 topics.');
    expect(topicDraft([typed('')], '').problem).not.toBeNull();
    expect(topicDraft([typed('agent'), typed(' Agent ')], '').problem).toBe('Remove duplicate topics.');
    expect(topicDraft([typed('я'.repeat(73))], '').problem).not.toBeNull();
    expect(topicDraft([typed('🚀'.repeat(72))], '').problem).toBeNull();
  });
});
