import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeKb, type FakeKb } from '../api/fake';
import { scenes, type SceneName } from '../api/fake/scenes';
import type { KbMessage } from '../../api/kb/types.gen';
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
    const fake = createFakeKb('home');
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
    const fake = createFakeKb('home');
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

describe('F2 · 03–05 · Research task states: running, paused, budget, done, and honest stops', () => {
  it('renders running state (03), polls GET /kb/explore/jobs ~1/s while visible, and pauses on Pause click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fake = createFakeKb('research_running');
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

    // 30 candidate dots, 18 done
    const dots = document.querySelectorAll('.kb-research-dots i');
    expect(dots).toHaveLength(30);
    expect(document.querySelectorAll('.kb-research-dots i.done')).toHaveLength(18);

    // Polls GET /kb/explore/jobs ~1/s while visible
    const jobsCallsBefore = vi.mocked(fake.explore.jobs).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    const jobsCallsAfter = vi.mocked(fake.explore.jobs).mock.calls.length;
    expect(jobsCallsAfter).toBeGreaterThanOrEqual(jobsCallsBefore + 2);

    // Clicking Pause calls POST /kb/research/tasks/task-rag/pause and transitions to Paused by you
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused by you')).toBeInTheDocument();
    expect(screen.getByText('12 candidate checks remain in this batch.')).toBeInTheDocument();
    expect(screen.getByText('Your findings are kept. Continue whenever you’re ready.')).toBeInTheDocument();
    expect(fake.research.pause).toHaveBeenCalledWith('task-rag');
  });

  it('renders paused state (04), resumes from checkpoint on Continue, and supports Cancel when paused', async () => {
    const user = userEvent.setup();
    const fake = createFakeKb('research_paused');
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused by you')).toBeInTheDocument();
    expect(screen.getByText('12 candidate checks remain in this batch.')).toBeInTheDocument();
    expect(screen.getByText('Your findings are kept. Continue whenever you’re ready.')).toBeInTheDocument();

    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    await user.click(continueBtn);

    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
    expect(fake.research.resume).toHaveBeenCalledWith('task-rag', {
      checkpoint_id: 'checkpoint-1',
      revision: 1,
      decision_choice: null,
    });

    // Pause again, then Cancel
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused by you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(fake.research.cancel).toHaveBeenCalledWith('task-rag');
  });

  it('renders budget-reached state (05) and starts a new 30-candidate batch on "Continue · next 30"', async () => {
    const user = userEvent.setup();
    const fake = createFakeKb('research_budget');
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText('Paused · batch complete')).toBeInTheDocument();
    expect(screen.getByText('Checked 240 · on topic 38 · new 9')).toBeInTheDocument();
    expect(screen.getByText('30 of 30 candidates compared with your wiki')).toBeInTheDocument();
    expect(document.querySelectorAll('.kb-research-dots i.done')).toHaveLength(30);
    expect(screen.getByText('A new batch uses your model allowance.')).toBeInTheDocument();
    expect(screen.getByText('This batch is finished. Your findings are ready to explore.')).toBeInTheDocument();

    const nextBatchBtn = screen.getByRole('button', { name: 'Continue · next 30' });
    await user.click(nextBatchBtn);

    expect(await screen.findByText('Checking against your wiki')).toBeInTheDocument();
    expect(screen.getByText('0 of 30 candidates compared with your wiki')).toBeInTheDocument();
    expect(fake.research.resume).toHaveBeenCalledWith('task-rag', {
      checkpoint_id: 'checkpoint-1',
      revision: 1,
      decision_choice: null,
    });
  });

  it('renders completed state (research_done) and lets the user message the task or view findings', async () => {
    const user = userEvent.setup();
    const onOpenFindings = vi.fn();
    const fake = createFakeKb('research_done');
    renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" onOpenFindings={onOpenFindings} />);

    expect(await screen.findByText('Research complete')).toBeInTheDocument();
    expect(screen.getByText('This batch is finished. Your findings are ready to explore.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View findings' }));
    expect(onOpenFindings).toHaveBeenCalledWith('task-rag');

    const composer = screen.getByRole('textbox', { name: 'Message research task' });
    await user.type(composer, 'Focus on claim-level metrics');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Focus on claim-level metrics')).toBeInTheDocument();
    expect(composer).toHaveValue('');
  });

  it.each([
    [
      'no_decision_model' as const,
      'Paused · decision model required',
      'Choose a model for Decisions in Settings → Models to compare candidates with your wiki.',
      'Open Settings → Models',
      'models',
    ],
    [
      'daily_limit' as const,
      'Paused · OpenAlex daily limit reached',
      'OpenAlex daily limit reached. Add a free OpenAlex key in Settings → Search, or continue tomorrow.',
      'Add key in Settings',
      'search',
    ],
  ])('renders honest stop reason for scene %s and opens the matching Settings section', async (scene, heading, copy, btnLabel, expectedSection) => {
    const user = userEvent.setup();
    const fake = createFakeKb(scene);
    const { services } = renderResearchOnly(fake, <ResearchTaskView taskId="task-rag" />);

    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: btnLabel }));
    expect(services.ui.getState()).toMatchObject({
      settingsOpen: true,
      settingsSection: expectedSection,
    });
  });

  it('renders honest stop reasons for science_consent_required and provider_unavailable', async () => {
    const user = userEvent.setup();
    const baseTask = structuredClone(scenes.research_paused.task);

    const consentFake = createFakeKb('research_paused');
    const consentTask = {
      ...baseTask,
      run: { ...baseTask.run, stop_reason: 'science_consent_required' as const },
    };
    const { services, unmount } = renderResearchOnly(
      consentFake,
      <ResearchTaskView initialTask={consentTask} />,
    );
    expect(await screen.findByText('Paused · scientific search is off')).toBeInTheDocument();
    expect(screen.getByText('Allow scientific database queries in Settings → Search to run this check.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Settings → Search' }));
    expect(services.ui.getState()).toMatchObject({
      settingsOpen: true,
      settingsSection: 'search',
    });
    unmount();

    const providerFake = createFakeKb('research_paused');
    const providerTask = {
      ...baseTask,
      run: { ...baseTask.run, stop_reason: 'provider_unavailable' as const },
    };
    renderResearchOnly(providerFake, <ResearchTaskView initialTask={providerTask} />);
    expect(await screen.findByText('Paused · database unavailable')).toBeInTheDocument();
    expect(screen.getByText('The scientific database did not respond. Your previous findings are kept.')).toBeInTheDocument();
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
    const fake = createFakeKb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);
    expect(isResearchPart(perm)).toBe(true);

    const { store } = renderResearchOnly(
      fake,
      <AssistantMessage chatId="c1" message={messageWithResearchPart(perm)} actions={noopActions} />,
    );

    const section = screen.getByRole('region', { name: 'Research permission' });
    expect(within(section).getByRole('heading', { name: 'Allow a research task?' })).toBeInTheDocument();
    expect(within(section).getByText('Find recent evidence for reliable RAG')).toBeInTheDocument();
    expect(within(section).getByText(/Searches scientific databases using topics and source identifiers/)).toBeInTheDocument();

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
    const fake = createFakeKb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);

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

  it('06 → 08 · Deny creates no task and no job and renders the quiet denied line', async () => {
    const user = userEvent.setup();
    const fake = createFakeKb('permission_pending');
    const perm = structuredClone(scenes.permission_pending.permission);

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
    const allowedFake = createFakeKb('permission_allowed');
    const allowedPerm = structuredClone(scenes.permission_allowed.permission);
    const { unmount } = renderResearchOnly(
      allowedFake,
      <ResearchPartView chatId="c1" part={allowedPerm} />,
    );
    expect(screen.getByText('Evidence for reliable RAG')).toBeInTheDocument();
    expect(screen.getByText('Research task · running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open task' })).toBeInTheDocument();
    unmount();

    const deniedFake = createFakeKb('permission_denied');
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
