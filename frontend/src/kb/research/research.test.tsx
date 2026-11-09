import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeKb, type FakeKb } from '../api/fake';
import { contractFixtures } from '../api/fake/fixtures';
import { scenes, type SceneName } from '../api/fake/scenes';
import type { KbMessage, KbResearchTask } from '../../api/kb/types.gen';
import { auditCss } from '../board/audit';
import { createServices, KbServicesProvider } from '../state/context';
import { createFakeBridge } from '../test/fakeBridge';
import { chatWorld } from '../test/fixtures';
import { AssistantMessage } from '../chat/Message';
import { SidePanel } from '../shell/SidePanel';
import { ChatCenter } from '../shell/ChatCenter';
import {
  bindResearchApi,
  ChatsPlusMenu,
  ResearchCenterView,
  ResearchGrantChip,
  ResearchPartView,
  ResearchTaskView,
  isResearchPart,
} from './index';

afterEach(() => {
  vi.useRealTimers();
});

/** A fake KB whose methods are spies, so a test can script an answer before it renders. */
function kb(scene?: SceneName): FakeKb {
  return spyOnFakeKb(createFakeKb(scene));
}

function spyOnFakeKb(fake: FakeKb): FakeKb {
  for (const key of Object.keys(fake.research) as Array<keyof FakeKb['research']>) {
    vi.spyOn(fake.research, key);
  }
  for (const key of Object.keys(fake.explore) as Array<keyof FakeKb['explore']>) {
    vi.spyOn(fake.explore, key);
  }
  return fake;
}

/**
 * Mount a test tree with a `KbServicesProvider` backed by `createFakeKb(scene)` for 0.4.0 routes
 * and `createFakeBridge(chatWorld())` for base 0.3.1 shell/chat routes.
 */
function renderWithScene(scene?: SceneName, ui?: React.ReactNode) {
  const fake = spyOnFakeKb(createFakeKb(scene));
  const base = createFakeBridge(chatWorld());
  const services = createServices(base.bridge, localStorage, { capture: null });
  const store = bindResearchApi(services.client, fake);
  const view = render(
    <KbServicesProvider services={services}>
      {ui ?? (
        <>
          <SidePanel width={240} />
          <ChatCenter hidden={false} />
        </>
      )}
    </KbServicesProvider>,
  );
  return { ...view, fake, base, services, store };
}

function renderResearchOnly(fake: FakeKb, node: React.ReactNode) {
  spyOnFakeKb(fake);
  const base = createFakeBridge(chatWorld());
  const services = createServices(base.bridge, localStorage, { capture: null });
  const store = bindResearchApi(services.client, fake);
  const view = render(
    <KbServicesProvider services={services}>
      {node}
    </KbServicesProvider>,
  );
  return { ...view, fake, services, store };
}

describe('F2 · 01 · Entry from «+» menu at Chats (G1 choice 1 = B)', () => {
  it('opens the «+» menu at Chats with a divider and separate Research section, and switches between New chat and New research task', async () => {
    const user = userEvent.setup();
    renderWithScene('home');

    const side = screen.getByRole('region', { name: 'Chats' });
    const plusBtn = within(side).getByRole('button', { name: 'New' });
    expect(plusBtn).toHaveAttribute('aria-expanded', 'false');

    await user.click(plusBtn);
    expect(plusBtn).toHaveAttribute('aria-expanded', 'true');

    const menu = await screen.findByRole('menu', { name: 'New' });
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    expect(within(menu).getByText('Research')).toBeInTheDocument();

    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['New chat', 'New research task']);

    await user.click(within(menu).getByRole('menuitem', { name: 'New research task' }));
    expect(screen.queryByRole('menu', { name: 'New' })).toBeNull();

    const researchCentre = screen.getByRole('region', { name: 'Research task' });
    expect(within(researchCentre).getByRole('heading', { name: 'New research task' })).toBeInTheDocument();
    expect(within(researchCentre).getByRole('heading', { name: 'What would you like to explore?' })).toBeInTheDocument();

    // Choosing "New chat" from the «+» menu returns the centre to the regular New chat view.
    await user.click(plusBtn);
    const menuAgain = await screen.findByRole('menu', { name: 'New' });
    await user.click(within(menuAgain).getByRole('menuitem', { name: 'New chat' }));
    expect(screen.queryByRole('region', { name: 'Research task' })).toBeNull();
    const chatCentre = screen.getByRole('region', { name: 'Chat' });
    expect(within(chatCentre).getByRole('heading', { name: 'New chat' })).toBeInTheDocument();
  });

  it('supports keyboard navigation (ArrowDown / ArrowUp / Escape) inside the «+» menu', async () => {
    const user = userEvent.setup();
    const fake = kb('home');
    renderResearchOnly(fake, <ChatsPlusMenu />);

    const plusBtn = screen.getByRole('button', { name: 'New' });
    await user.click(plusBtn);
    const menu = await screen.findByRole('menu', { name: 'New' });
    const [newChatItem, newResearchItem] = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(newChatItem).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(newResearchItem).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(newChatItem).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'New' })).toBeNull());
  });
});

describe('F2 · 02 · New research task template & starters', () => {
  it('renders the template, populates the prompt from all 3 starters, and starts a research task via research.create', async () => {
    const user = userEvent.setup();
    const fake = kb('home');
    vi.mocked(fake.research.create).mockImplementation(async (body) => ({
      ...structuredClone(scenes.research_running.task),
      description: body.description,
    }));
    renderResearchOnly(fake, <ResearchCenterView initialMode="new" />);

    expect(screen.getByRole('heading', { name: 'New research task' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What would you like to explore?' })).toBeInTheDocument();
    expect(screen.getByText('Find useful additions to your wiki, or investigate a topic.')).toBeInTheDocument();
    expect(screen.getByText('Up to 30 candidates checked against your wiki')).toBeInTheDocument();

    const promptInput = screen.getByRole('textbox', { name: 'Describe what you want to find or learn' });
    const startBtn = screen.getByRole('button', { name: 'Start research' });
    expect(startBtn).toBeDisabled();

    // Starter 1: Something new for my wiki
    await user.click(screen.getByRole('button', { name: 'Something new for my wiki' }));
    expect(promptInput).toHaveValue('Find something new for my wiki.');
    expect(startBtn).toBeEnabled();

    // Starter 2: Materials about …
    await user.click(screen.getByRole('button', { name: 'Materials about …' }));
    expect(promptInput).toHaveValue('Find materials about ');

    // Starter 3: Recent research on …
    await user.click(screen.getByRole('button', { name: 'Recent research on …' }));
    expect(promptInput).toHaveValue('Find recent research on ');
    await user.type(promptInput, 'reliable RAG evaluation');
    expect(promptInput).toHaveValue('Find recent research on reliable RAG evaluation');

    await user.click(startBtn);

    await waitFor(() => {
      expect(fake.research.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Find recent research on reliable RAG evaluation',
        }),
      );
    });

    // Transitions into the running research task chat view
    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
    expect(screen.getByText('Find recent research on reliable RAG evaluation')).toBeInTheDocument();
  });
});

type Task = KbResearchTask;

function taskWith(base: Task, run: Partial<Task['run']>): Task {
  return { ...structuredClone(base), run: { ...structuredClone(base.run), ...run } };
}

describe('F2 · 03–05 · Research task states: running, paused, budget, done, and honest stops', () => {
  it('renders running state (03), polls GET /kb/explore/jobs ~1/s while visible, and pauses on Pause click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fake = kb('research_running');
    const running = scenes.research_running.task;
    const paused = taskWith(running, { state: 'paused', stop_reason: 'user_pause' });
    vi.mocked(fake.research.pause).mockResolvedValue(paused);
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByRole('heading', { name: 'Evidence for reliable RAG' })).toBeInTheDocument();
    expect(screen.getByText('Find recent work on evaluating RAG answers. Look for evidence that adds to Lecture 7.')).toBeInTheDocument();
    expect(screen.getByText('Checking against your wiki')).toBeInTheDocument();
    expect(screen.getByText('Checked 240 · on topic 38 · new 6')).toBeInTheDocument();
    expect(screen.getByText('18 of 30 candidates compared with your wiki')).toBeInTheDocument();
    expect(screen.getByText('Budget: 30 candidate checks per batch')).toBeInTheDocument();
    expect(screen.getByText('You can leave this chat. Findings appear in Explore as they are ready.')).toBeInTheDocument();
    expect(screen.getByText('Findings in Explore → New')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View findings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    // 30 candidate dots, 18 done
    expect(document.querySelectorAll('.kb-research-dots i')).toHaveLength(30);
    expect(document.querySelectorAll('.kb-research-dots i.done')).toHaveLength(18);

    // Polls GET /kb/explore/jobs ~1/s while visible; the task is not re-read while its job is unchanged
    const jobsBefore = vi.mocked(fake.explore.jobs).mock.calls.length;
    const taskBefore = vi.mocked(fake.research.task).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(vi.mocked(fake.explore.jobs).mock.calls.length).toBeGreaterThanOrEqual(jobsBefore + 2);
    expect(vi.mocked(fake.explore.jobs)).toHaveBeenCalledWith({ active: true });
    expect(vi.mocked(fake.research.task).mock.calls.length).toBe(taskBefore);

    // Pause: the server's answer is the new state
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused by you')).toBeInTheDocument();
    expect(screen.getByText('12 candidate checks remain in this batch.')).toBeInTheDocument();
    expect(screen.getByText('Your findings are kept. Continue whenever you’re ready.')).toBeInTheDocument();
    expect(fake.research.pause).toHaveBeenCalledWith('task-rag');
  });

  it('re-reads the task when its job changed, and stops polling once it is no longer running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = kb('research_running');
    const running = scenes.research_running.task;
    const advanced = taskWith(running, {
      updated_at: '2026-11-09T10:00:05Z',
      budget: { ...running.run.budget, used: 20, remaining: 10 },
    });
    const job = structuredClone(contractFixtures.KbJobs.jobs[0]!);
    job.updated_at = '2026-11-09T10:00:05Z';
    vi.mocked(fake.explore.jobs).mockResolvedValue({ jobs: [job] });
    vi.mocked(fake.research.task).mockResolvedValueOnce(running).mockResolvedValue(advanced);
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('18 of 30 candidates compared with your wiki')).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(await screen.findByText('20 of 30 candidates compared with your wiki')).toBeInTheDocument();
  });

  it('shows the server error and keeps the state when Pause fails', async () => {
    const user = userEvent.setup();
    const fake = kb('research_running');
    vi.mocked(fake.research.pause).mockRejectedValue(new Error('Task already finished'));
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Task already finished');
    expect(screen.getByText('Checking against your wiki')).toBeInTheDocument();
  });

  it('renders paused state (04), resumes from the task’s own checkpoint on Continue, and offers Cancel only while paused', async () => {
    const user = userEvent.setup();
    const fake = kb('research_paused');
    const paused = scenes.research_paused.task;
    const checkpoint = { ...paused.run.checkpoint!, id: 'cp-77', revision: 4 };
    vi.mocked(fake.research.task).mockResolvedValue(taskWith(paused, { checkpoint }));
    vi.mocked(fake.research.resume).mockResolvedValue(taskWith(paused, { state: 'running', stop_reason: null, checkpoint }));
    vi.mocked(fake.research.cancel).mockResolvedValue(taskWith(paused, { state: 'cancelled', stop_reason: 'cancelled', checkpoint }));
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused by you')).toBeInTheDocument();
    expect(screen.getByText('12 candidate checks remain in this batch.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
    expect(fake.research.resume).toHaveBeenCalledWith('task-rag', {
      checkpoint_id: 'cp-77',
      revision: 4,
      decision_choice: null,
    });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('Cancel on a paused task shows the server’s cancelled state', async () => {
    const user = userEvent.setup();
    const fake = kb('research_paused');
    const paused = scenes.research_paused.task;
    vi.mocked(fake.research.cancel).mockResolvedValue(taskWith(paused, { state: 'cancelled', stop_reason: 'cancelled' }));
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(fake.research.cancel).toHaveBeenCalledWith('task-rag');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('a stale checkpoint (409) shows the error and re-reads the task', async () => {
    const user = userEvent.setup();
    const fake = kb('research_paused');
    vi.mocked(fake.research.resume).mockRejectedValue(new Error('conflict'));
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fake.research.task).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('renders budget-reached state (05) and starts the next batch on "Continue · next 30"', async () => {
    const user = userEvent.setup();
    const fake = kb('research_budget');
    const budget = scenes.research_budget.task;
    const next = taskWith(budget, {
      state: 'running', stop_reason: null,
      budget: { ...budget.run.budget, used: 0, remaining: 30, batch: 2 },
    });
    vi.mocked(fake.research.resume).mockResolvedValue(next);
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused · batch complete')).toBeInTheDocument();
    expect(screen.getByText('Checked 240 · on topic 38 · new 9')).toBeInTheDocument();
    expect(screen.getByText('30 of 30 candidates compared with your wiki')).toBeInTheDocument();
    expect(document.querySelectorAll('.kb-research-dots i.done')).toHaveLength(30);
    expect(screen.getByText('A new batch uses your model allowance.')).toBeInTheDocument();
    expect(screen.getByText('This batch is finished. Your findings are ready to explore.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue · next 30' }));
    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
    expect(screen.getByText('0 of 30 candidates compared with your wiki')).toBeInTheDocument();
    expect(fake.research.resume).toHaveBeenCalledWith('task-rag', expect.objectContaining({ checkpoint_id: 'checkpoint-1' }));
  });

  it('renders the completed state without Continue, and View findings goes to Explore', async () => {
    const user = userEvent.setup();
    const onOpenFindings = vi.fn();
    const fake = kb('research_done');
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" onOpenFindings={onOpenFindings} />);

    expect(await screen.findByText('Research complete')).toBeInTheDocument();
    expect(screen.getByText('This batch is finished. Your findings are ready to explore.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'View findings' }));
    expect(onOpenFindings).toHaveBeenCalledWith('task-rag');
  });

  it('View findings without a handler switches the rail to Explore', async () => {
    const user = userEvent.setup();
    const fake = kb('research_done');
    const { services } = renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);
    await user.click(await screen.findByRole('button', { name: 'View findings' }));
    expect(services.prefs.getState().section).toBe('explore');
  });

  it('a follow-up is a real message in the task’s own chat, then the centre shows that chat', async () => {
    const user = userEvent.setup();
    const fake = kb('research_done');
    const { services, store } = renderResearchOnly(fake, <ResearchCenterView initialMode="task" initialTaskId="task-rag" />);
    const open = vi.spyOn(services.chats.getState(), 'open');
    const send = vi.spyOn(services.chats.getState(), 'send').mockResolvedValue({ ok: true, value: 'chat-research-rag' });

    const composer = await screen.findByRole('textbox', { name: 'Message research task' });
    await user.type(composer, 'Focus on claim-level metrics');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(open).toHaveBeenCalledWith('chat-research-rag');
    expect(send).toHaveBeenCalledWith(
      { text: 'Focus on claim-level metrics', mentions: [], quotes: [], attachments: [] },
      {},
    );
    await waitFor(() => expect(store.getState().mode).toBe('closed'));
  });

  it('a failed follow-up keeps the text and the task view, and says why', async () => {
    const user = userEvent.setup();
    const fake = kb('research_done');
    const { services, store } = renderResearchOnly(fake, <ResearchCenterView initialMode="task" initialTaskId="task-rag" />);
    vi.spyOn(services.chats.getState(), 'send').mockResolvedValue({ ok: false, error: 'No agent is available' });

    const composer = await screen.findByRole('textbox', { name: 'Message research task' });
    await user.type(composer, 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No agent is available');
    expect(composer).toHaveValue('Hello');
    expect(store.getState().mode).toBe('task');
  });

  it('decision_model_required: offers the choices from the run and sends the picked one with Continue', async () => {
    const user = userEvent.setup();
    const fake = kb('research_paused');
    const paused = scenes.research_paused.task;
    const stopped = taskWith(paused, {
      stop_reason: 'decision_model_required',
      decision_provider: null,
      decision_choices: ['download_local', 'openrouter_jev'],
    });
    vi.mocked(fake.research.task).mockResolvedValue(stopped);
    vi.mocked(fake.research.resume).mockResolvedValue(taskWith(paused, { state: 'running', stop_reason: null }));
    const { services } = renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused · decision model required')).toBeInTheDocument();
    expect(screen.getByText('Choose a model for Decisions in Settings → Models to compare candidates with your wiki.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use OpenRouter · Jev (paid)' })).toBeInTheDocument();
    // No silent fallback: a plain Continue is not offered while a choice is required.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open Settings → Models' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'models' });

    await user.click(screen.getByRole('button', { name: 'Download a local model' }));
    expect(fake.research.resume).toHaveBeenCalledWith('task-rag', expect.objectContaining({ decision_choice: 'download_local' }));
    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
  });

  it('openalex_daily_limit: honest message with retry time and a way to Settings → Search', async () => {
    const user = userEvent.setup();
    const fake = kb('research_paused');
    const paused = scenes.research_paused.task;
    vi.mocked(fake.research.task).mockResolvedValue(
      taskWith(paused, { stop_reason: 'openalex_daily_limit', retry_at: '2026-11-10T00:00:00Z' }),
    );
    const { services } = renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused · OpenAlex daily limit reached')).toBeInTheDocument();
    expect(screen.getByText(/OpenAlex daily limit reached\. Add a free OpenAlex key in Settings → Search, or continue tomorrow\. Try again after/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add key in Settings' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'search' });
  });

  it('science_consent_required, provider_unavailable and app_exit say what happened', async () => {
    const user = userEvent.setup();
    const paused = scenes.research_paused.task;

    const consent = kb('research_paused');
    const { services, unmount } = renderResearchOnly(
      consent,
      <ResearchTaskView initialTask={taskWith(paused, { stop_reason: 'science_consent_required' })} />,
    );
    expect(await screen.findByText('Paused · scientific search is off')).toBeInTheDocument();
    expect(screen.getByText('Allow scientific database queries in Settings → Search to run this check.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Settings → Search' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'search' });
    unmount();

    const provider = kb('research_paused');
    const second = renderResearchOnly(
      provider,
      <ResearchTaskView initialTask={taskWith(paused, { stop_reason: 'provider_unavailable' })} />,
    );
    expect(await screen.findByText('Paused · database unavailable')).toBeInTheDocument();
    expect(screen.getByText('The scientific database did not respond. Your previous findings are kept.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    second.unmount();

    const exit = kb('research_paused');
    renderResearchOnly(exit, <ResearchTaskView initialTask={taskWith(paused, { stop_reason: 'app_exit' })} />);
    expect(await screen.findByText('Paused when SKAZ closed')).toBeInTheDocument();
    expect(screen.getByText(/It resumes next time SKAZ starts/)).toBeInTheDocument();
  });

  it('a failed task has no Continue and says it stopped', async () => {
    const fake = kb('research_paused');
    const paused = scenes.research_paused.task;
    renderResearchOnly(
      fake,
      <ResearchTaskView initialTask={taskWith(paused, { state: 'error', stop_reason: 'failed' })} />,
    );
    expect(await screen.findByText('Stopped · error')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('The task stopped before it finished. Findings already kept remain in Explore.')).toBeInTheDocument();
  });
});

describe('F2 · task list in the Chats panel and centre routing', () => {
  it('lists research tasks from GET /kb/research/tasks and opens one in the centre', async () => {
    const user = userEvent.setup();
    const fake = kb('research_running');
    vi.mocked(fake.research.task).mockResolvedValue(scenes.research_running.task);
    const { store } = renderWithScene('research_running');
    const side = screen.getByRole('region', { name: 'Chats' });

    const list = await within(side).findByRole('region', { name: 'Research tasks' });
    await user.click(within(list).getByRole('button', { name: 'Verify wiki claims' }));
    expect(store.getState().mode).toBe('task');
    expect(store.getState().activeTaskId).toBe('task-1');
    expect(screen.getByRole('region', { name: 'Research task' })).toBeInTheDocument();
  });

  it('opening any chat leaves the research task view', async () => {
    const { services, store } = renderWithScene('home');
    act(() => store.getState().openNewTask());
    expect(screen.getByRole('region', { name: 'Research task' })).toBeInTheDocument();

    act(() => services.chats.getState().open('c1'));
    await waitFor(() => expect(store.getState().mode).toBe('closed'));
    expect(screen.queryByRole('region', { name: 'Research task' })).toBeNull();
  });
});

describe('F2 · 06–08 · Permission card, compact pointer, and denied line in normal chats', () => {
  const noopActions = {
    busy: null,
    onRegenerate: () => {},
    onResume: () => {},
    onSave: () => {},
  };

  function messageWithResearchPart(part: unknown): KbMessage {
    return {
      id: 'm-res-1',
      seq: 1,
      role: 'assistant',
      state: 'done',
      engine: 'claude_code',
      model: 'claude-sonnet-4-6',
      created_at: '2026-10-27T09:10:00Z',
      saved_page_id: null,
      failure: null,
      input: null,
      parts: [
        { type: 'text', text: 'I can start a research task for recent studies and compare their claims with your wiki.' },
        part as KbMessage['parts'][number],
      ],
    };
  }

  it('06 · pending → Allow once calls POST /kb/research/permissions/{id}/decide and turns into compact pointer (07)', async () => {
    const user = userEvent.setup();
    const fake = kb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);
    expect(isResearchPart(perm)).toBe(true);
    vi.mocked(fake.research.decide).mockResolvedValue({ ...scenes.permission_allowed.permission, id: perm.id });
    vi.mocked(fake.research.task).mockResolvedValue(scenes.research_running.task);

    const { store } = renderResearchOnly(
      fake,
      <AssistantMessage chatId="c1" message={messageWithResearchPart(perm)} actions={noopActions} />,
    );

    const section = screen.getByRole('region', { name: 'Research permission' });
    expect(within(section).getByRole('heading', { name: 'Allow a research task?' })).toBeInTheDocument();
    expect(within(section).getByText('Find recent evidence for reliable RAG')).toBeInTheDocument();
    expect(within(section).getByText(/Only topics and source identifiers go to scientific databases, never your description/)).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Allow once' }));

    await waitFor(() => {
      expect(fake.research.decide).toHaveBeenCalledWith('permission-1', { decision: 'allow' });
    });

    // Renders compact pointer (07)
    expect(await screen.findByText('Research task · running')).toBeInTheDocument();
    const openBtn = screen.getByRole('button', { name: 'Open task' });
    await user.click(openBtn);
    expect(store.getState().mode).toBe('task');
    expect(store.getState().activeTaskId).toBe('task-rag');
  });

  it('06 · pending → Allow in this chat grants chat-level permission and shows the revocable chip', async () => {
    const user = userEvent.setup();
    const fake = kb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);
    vi.mocked(fake.research.decide).mockResolvedValue({ ...scenes.permission_allowed.permission, id: perm.id, auto: true });
    vi.mocked(fake.research.task).mockResolvedValue(scenes.research_running.task);
    vi.mocked(fake.research.revoke_grant).mockResolvedValue({ chat_id: 'chat-current', kind: 'research_start', allowed: false, granted_at: null });

    renderResearchOnly(
      fake,
      <>
        <ResearchGrantChip chatId="chat-current" />
        <ResearchPartView chatId="chat-current" part={perm} />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Allow in this chat' }));

    await waitFor(() => {
      expect(fake.research.decide).toHaveBeenCalledWith('permission-1', { decision: 'allow_chat' });
    });

    // Chat grant chip appears and can be revoked via DELETE /kb/chats/{chat_id}/research-grant
    const chip = await screen.findByRole('button', { name: 'Research allowed in this chat' });
    await user.click(chip);
    const pop = await screen.findByRole('dialog', { name: 'Research in this chat' });
    await user.click(within(pop).getByRole('button', { name: 'Ask every time again' }));

    await waitFor(() => {
      expect(fake.research.revoke_grant).toHaveBeenCalledWith('chat-current');
    });
    expect(screen.queryByRole('button', { name: 'Research allowed in this chat' })).toBeNull();
  });

  it('the chat’s grant is read from the server, so the chip returns after a restart, and a failed revoke says so', async () => {
    const user = userEvent.setup();
    const fake = kb('home');
    vi.mocked(fake.research.grant).mockResolvedValue({ chat_id: 'chat-current', kind: 'research_start', allowed: true, granted_at: '2026-11-09T10:00:00Z' });
    vi.mocked(fake.research.revoke_grant).mockRejectedValue(new Error('Could not reach SKAZ'));
    renderResearchOnly(fake, <ResearchGrantChip chatId="chat-current" />);

    const chip = await screen.findByRole('button', { name: 'Research allowed in this chat' });
    expect(fake.research.grant).toHaveBeenCalledWith('chat-current');
    await user.click(chip);
    const pop = await screen.findByRole('dialog', { name: 'Research in this chat' });
    await user.click(within(pop).getByRole('button', { name: 'Ask every time again' }));
    expect(await within(pop).findByRole('alert')).toHaveTextContent('Could not reach SKAZ');
    expect(screen.getByRole('button', { name: 'Research allowed in this chat' })).toBeInTheDocument();
  });

  it('a failed decision keeps the card and shows why', async () => {
    const user = userEvent.setup();
    const fake = kb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);
    vi.mocked(fake.research.decide).mockRejectedValue(new Error('Already decided'));
    renderResearchOnly(fake, <ResearchPartView chatId="c1" part={perm} />);

    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already decided');
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('06 → 08 · Deny creates no task and no job and renders the quiet denied line', async () => {
    const user = userEvent.setup();
    const fake = kb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);
    vi.mocked(fake.research.decide).mockResolvedValue({ ...scenes.permission_denied.permission, id: perm.id });

    const { store } = renderResearchOnly(
      fake,
      <AssistantMessage chatId="c1" message={messageWithResearchPart(perm)} actions={noopActions} />,
    );

    await user.click(screen.getByRole('button', { name: 'Deny' }));

    await waitFor(() => {
      expect(fake.research.decide).toHaveBeenCalledWith('permission-1', { decision: 'deny' });
    });
    expect(fake.research.create).not.toHaveBeenCalled();
    expect(fake.research.task).not.toHaveBeenCalled();
    expect(store.getState().tasks).toHaveLength(0);
    expect(await screen.findByText('Research wasn’t started. I can help you review the materials already in your wiki.')).toBeInTheDocument();
  });

  it('renders pre-seeded permission_allowed (07) and permission_denied (08) scenes directly', () => {
    const allowedFake = kb('permission_allowed');
    const allowedPerm = structuredClone(scenes.permission_allowed.permission);
    const { unmount } = renderResearchOnly(
      allowedFake,
      <ResearchPartView chatId="c1" part={allowedPerm} />,
    );
    expect(screen.getByText('Evidence for reliable RAG')).toBeInTheDocument();
    expect(screen.getByText('Research task · running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task' })).toBeInTheDocument();
    unmount();

    const deniedFake = kb('permission_denied');
    const deniedPerm = structuredClone(scenes.permission_denied.permission);
    renderResearchOnly(
      deniedFake,
      <ResearchPartView chatId="c1" part={deniedPerm} />,
    );
    expect(screen.getByText('Research wasn’t started. I can help you review the materials already in your wiki.')).toBeInTheDocument();
  });
});

describe('F2 · Design-system token audit on research.css', () => {
  it('uses only tokens from tokens.css with zero literal colours, px font sizes, px radii, or non-token spacing', () => {
    const css = readFileSync(resolve(__dirname, './research.css'), 'utf8');
    const report = auditCss({ 'kb/research/research.css': css });
    expect(report.colors).toEqual([]);
    expect(report.fontSizes).toEqual([]);
    expect(report.radii).toEqual([]);
    expect(report.shadows).toBe(0);
    expect(report.spacing.filter((s) => s.value !== '1px')).toEqual([]);
  });
});
