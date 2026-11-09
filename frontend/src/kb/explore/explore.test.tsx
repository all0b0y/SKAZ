import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeKb } from '../api/fake';
import { contractFixtures } from '../api/fake/fixtures';
import { scenes } from '../api/fake/scenes';
import { auditCss } from '../board/audit';
import type { DocTarget } from '../state/document';
import { ExploreSection } from './ExploreSection';
import { formatWikiShare, squarify, tileWeight } from './treemap';
import type { FindingHostProps } from './types';

describe('F1 — Explore treemap math (treemap.ts)', () => {
  it('squarifies items preserving total area and staying within bounds', () => {
    const items = [
      { id: 'a', weight: 239 },
      { id: 'b', weight: 128 },
      { id: 'c', weight: 29 },
      { id: 'd', weight: 16 },
    ];
    const rects = squarify(items, 0, 0, 600, 400);
    expect(rects).toHaveLength(4);

    const totalArea = rects.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(totalArea).toBeCloseTo(600 * 400, 1);

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(600.01);
      expect(r.y + r.h).toBeLessThanOrEqual(400.01);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });

  it('returns empty array when given no items or non-positive dimensions', () => {
    expect(squarify([], 0, 0, 500, 300)).toEqual([]);
    expect(squarify([{ id: 'a', weight: 10 }], 0, 0, 0, 300)).toEqual([]);
  });

  it('computes minimum positive weight for gap tiles so 0-page gaps remain visible', () => {
    const gapArea = scenes.topic.map.areas.find((a) => a.pages === 0)!;
    const regularArea = scenes.topic.map.areas.find((a) => a.pages > 0)!;
    expect(tileWeight(gapArea, 62)).toBeCloseTo(62 * 0.045, 2);
    expect(tileWeight(regularArea, 62)).toBe(regularArea.pages);
  });

  it('formats wiki share percentages cleanly', () => {
    expect(formatWikiShare(239 / 412)).toBe('58%');
    expect(formatWikiShare(16 / 412)).toBe('3.9%');
    expect(formatWikiShare(2 / 412)).toBe('<1%');
    expect(formatWikiShare(0)).toBe('0%');
  });
});

describe('F1 — ExploreSection UI & interactions', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-motion');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders Home scene with domain tiles, search scope, grouped findings, OpenAlex hint, and Worth closing', async () => {
    const kb = createFakeKb('home');
    const dismissSpy = vi.spyOn(kb.science, 'dismiss_hint');

    render(<ExploreSection clients={kb} />);

    // Domains on map
    await screen.findByRole('button', { name: /Physical Sciences/i });
    expect(screen.getByRole('button', { name: /Social Sciences/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Life Sciences/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Health Sciences/i })).toBeTruthy();

    // Search bar scope & Weekly indicator
    expect(screen.getByText('in all your areas')).toBeTruthy();
    expect(screen.getByPlaceholderText(/What exactly\? Optional/i)).toBeTruthy();
    expect(screen.getByText('Weekly · Mon')).toBeTruthy();

    // Grouped findings in New tab (G1-2A)
    expect(screen.getByText('Evidence for reliable RAG')).toBeTruthy();
    expect(screen.getByText('Something new for my wiki')).toBeTruthy();
    expect(screen.getByText(/12 repeat what you have/i)).toBeTruthy();

    // Only "Contradicts your wiki" has signal styling
    const contradictsLabel = screen.getByText('Contradicts your wiki');
    expect(contradictsLabel.classList.contains('kb-explore-signal')).toBe(true);
    const newLabels = screen.getAllByText('New');
    for (const el of newLabels) {
      expect(el.classList.contains('kb-explore-signal')).toBe(false);
    }

    // One-time OpenAlex full-text key hint
    expect(screen.getByText(/Add a free OpenAlex key to get full text for 1 of these/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss OpenAlex key hint/i }));
    await waitFor(() => expect(dismissSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Add a free OpenAlex key to get full text for 1 of these/i)).toBeNull();

    // Worth closing section
    expect(screen.getByText('Worth closing')).toBeTruthy();
    expect(screen.getByText('Self-correction and verification')).toBeTruthy();
    expect(screen.getByText('Evaluating LLM answers')).toBeTruthy();
  });

  it('shows hover tooltip with wiki share, pages, sources, depth, and marked/new counts', async () => {
    const kb = createFakeKb('home');
    render(<ExploreSection clients={kb} />);

    const physTile = await screen.findByRole('button', { name: /Physical Sciences/i });
    fireEvent.mouseEnter(physTile);

    const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getByText(/58% of your wiki · 239 pages/i)).toBeTruthy();
    expect(within(tooltip).getByText(/74 sources, newest 2026 · dense/i)).toBeTruthy();
    expect(within(tooltip).getByText(/You marked 19 · 7 new/i)).toBeTruthy();

    fireEvent.mouseLeave(physTile);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('drills down into an area on tile click, updates breadcrumbs and search scope, and navigates back', async () => {
    const kb = createFakeKb('home');
    const openedSpy = vi.spyOn(kb.areas, 'opened');
    const mapSpy = vi.spyOn(kb.areas, 'map').mockImplementation(async (params) => {
      if (params?.parent_id === 'domain-physical' || params?.parent_id === 'field-cs') {
        return structuredClone(scenes.area.map);
      }
      return structuredClone(scenes.home.map);
    });

    render(<ExploreSection clients={kb} />);

    const physTile = await screen.findByRole('button', { name: /Physical Sciences/i });
    fireEvent.click(physTile);

    await waitFor(() => expect(openedSpy).toHaveBeenCalledWith('domain-physical'));
    expect(mapSpy).toHaveBeenCalledWith({ parent_id: 'domain-physical' });

    // Area scene loaded (Computer Science)
    await screen.findByRole('button', { name: /Artificial Intelligence/i });
    expect(screen.getByText('in Computer Science')).toBeTruthy();
    expect(screen.getByText('41% of your wiki')).toBeTruthy();

    // Click root Explore breadcrumb to return home
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    await screen.findByRole('button', { name: /Physical Sciences/i });
    expect(screen.getByText('in all your areas')).toBeTruthy();
  });

  it('selects a leaf topic in place, switches to Your materials tab, opens material in DocPanel, and runs older materials check', async () => {
    const kb = createFakeKb('topic');
    const startRepeatSpy = vi.spyOn(kb.repeats, 'start').mockResolvedValue({
      ...scenes.older_running.repeatCheck,
      state: 'running',
    });
    const pauseRepeatSpy = vi.spyOn(kb.repeats, 'pause').mockResolvedValue({
      ...scenes.older_paused.repeatCheck,
    });

    const openedDocs: DocTarget[] = [];
    render(<ExploreSection clients={kb} onOpenDocument={(doc) => openedDocs.push(doc)} />);

    // In topic scene, Retrieval-augmented generation is selected and Your materials tab is active
    await screen.findByText('RAG beyond the basics');
    expect(screen.getByText(/Repeats Lecture 7 · ~80%/i)).toBeTruthy();
    expect(screen.getByText(/you: Useful method/i)).toBeTruthy();
    expect(screen.getByText(/Not checked for repeats/i)).toBeTruthy();

    // Clicking a material row opens it in DocPanel
    fireEvent.click(screen.getByText('RAG beyond the basics'));
    expect(openedDocs).toEqual([{ type: 'material', id: 'material-beyond' }]);

    // Older materials check button (not_checked_count === 2)
    const checkBtn = screen.getByRole('button', { name: /Check older materials/i });
    fireEvent.click(checkBtn);
    await waitFor(() => expect(startRepeatSpy).toHaveBeenCalledWith({ area_id: 'topic-rag' }));

    // Shows running repeat check progress with Pause button
    await screen.findByText(/Checking older materials/i);
    expect(screen.getByText(/2 of 7 materials checked/i)).toBeTruthy();
    expect(screen.getByText(/Budget used: 18 of 30 claim comparisons/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(pauseRepeatSpy).toHaveBeenCalled());
    await screen.findByText(/Repeat check paused/i);
  });

  it('starts a search with optional query, renders 5 funnel steps and shine band, and pauses on Stop', async () => {
    const kb = createFakeKb('area');
    const startSpy = vi.spyOn(kb.explore, 'start').mockResolvedValue(structuredClone(scenes.searching.run));
    const pauseSpy = vi.spyOn(kb.explore, 'pause').mockResolvedValue({
      ...structuredClone(scenes.searching.run),
      state: 'paused',
      stop_reason: 'user_pause',
    });

    const { container } = render(<ExploreSection clients={kb} />);
    await screen.findByRole('button', { name: /Artificial Intelligence/i });

    const input = screen.getByPlaceholderText(/What exactly\? Optional/i);
    fireEvent.change(input, { target: { value: 'evaluating RAG answers' } });
    fireEvent.click(screen.getByRole('button', { name: /Find what's new/i }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({
        area_id: 'field-cs',
        query: 'evaluating RAG answers',
      }),
    );

    // Running state in search bar and column
    await screen.findByText(/step 3 of 5/i);
    expect(screen.getByText(/Collect from OpenAlex, arXiv/i)).toBeTruthy();
    expect(screen.getByText('240')).toBeTruthy();
    expect(screen.getByText('198 left')).toBeTruthy();
    expect(screen.getByText('120 of 198')).toBeTruthy();
    expect(screen.getByText(/local model · free/i)).toBeTruthy();
    expect(screen.getByText(/uses your subscription/i)).toBeTruthy();

    // Shine band on map slot
    const slot = container.querySelector('.kb-explore-map__slot');
    expect(slot?.classList.contains('is-scanning')).toBe(true);

    // Clicking Stop pauses the run
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith('run-search'));
  });

  it('polls explore.jobs({ active: true }) at ~1s while visible and skips polling when hidden', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('searching');
    const jobsSpy = vi.spyOn(kb.explore, 'jobs');

    const { rerender } = render(<ExploreSection clients={kb} />);
    await act(async () => {
      await Promise.resolve();
    });
    const initialCalls = jobsSpy.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(jobsSpy.mock.calls.length).toBeGreaterThan(initialCalls);

    const callsBeforeHide = jobsSpy.mock.calls.length;
    rerender(<ExploreSection clients={kb} hidden />);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(jobsSpy.mock.calls.length).toBe(callsBeforeHide);
  });

  it('renders honest stops for decision_model_required, openalex_daily_limit, and budget pause', async () => {
    // 1. decision_model_required
    const kbNoModel = createFakeKb('no_decision_model');
    const resumeSpy = vi.spyOn(kbNoModel.explore, 'resume').mockResolvedValue(structuredClone(scenes.searching.run));
    const { unmount } = render(<ExploreSection clients={kbNoModel} />);

    await screen.findByText(/Choose how to sort candidates by area/i);
    const localBtn = screen.getByRole('button', { name: /Download local model/i });
    expect(screen.getByRole('button', { name: /OpenRouter Jev/i })).toBeTruthy();
    fireEvent.click(localBtn);
    await waitFor(() =>
      expect(resumeSpy).toHaveBeenCalledWith('run-search', {
        decision_choice: 'download_local',
      }),
    );
    unmount();

    // 2. openalex_daily_limit
    const kbLimit = createFakeKb('daily_limit');
    const { unmount: unmountLimit } = render(<ExploreSection clients={kbLimit} />);
    await screen.findByText(/OpenAlex daily limit reached/i);
    expect(screen.getByText(/2026-11-10/i)).toBeTruthy();
    unmountLimit();

    // 3. budget pause (Continue · next 30 + Cancel)
    const kbBudget = createFakeKb('searching');
    kbBudget.explore.run = async () => ({
      ...structuredClone(scenes.searching.run),
      state: 'paused',
      stage: 'novelty',
      stop_reason: 'budget',
      checkpoint: structuredClone(contractFixtures.KbFunnelRun.checkpoint),
      budget: { unit: 'candidate', limit: 30, used: 30, remaining: 0, total_used: 30, batch: 1, free_only: false },
    });
    const budgetResumeSpy = vi.spyOn(kbBudget.explore, 'resume');
    const budgetCancelSpy = vi.spyOn(kbBudget.explore, 'cancel');
    render(<ExploreSection clients={kbBudget} />);

    const next30Btn = await screen.findByRole('button', { name: /Continue · next 30/i });
    fireEvent.click(next30Btn);
    await waitFor(() =>
      expect(budgetResumeSpy).toHaveBeenCalledWith('run-search', {
        checkpoint_id: 'checkpoint-1',
        revision: 1,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(budgetCancelSpy).toHaveBeenCalledWith('run-search'));
  });

  it('renders Done state with Done just now banner and pop badges', async () => {
    const kb = createFakeKb('done');
    const { container } = render(<ExploreSection clients={kb} />);

    await screen.findByText(/Done just now/i);
    expect(screen.getByText(/12 repeat what you have/i)).toBeTruthy();
    expect(container.querySelector('.kb-explore-tile__new.is-pop')).toBeTruthy();
  });

  it('opens a finding in the column (G1-3A), supports Explore menu modes and Add to wiki, and supports custom FindingComponent host', async () => {
    const kb = createFakeKb('find');
    const exploreSpy = vi.spyOn(kb.explore, 'explore');
    const addToWikiSpy = vi.spyOn(kb.explore, 'add_to_wiki');

    const { container, unmount } = render(<ExploreSection clients={kb} />);

    await screen.findByRole('heading', {
      name: /Self-correction in LLMs does not improve factuality without external feedback/i,
    });
    expect(container.querySelector('.kb-explore-col--wide')).toBeTruthy();

    // Open Explore menu and pick Brief tour
    fireEvent.click(screen.getByRole('button', { name: /^Explore/i }));
    const briefTourBtn = await screen.findByRole('button', { name: /Brief tour/i });
    expect(screen.getByRole('button', { name: /Deep dive/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Notes/i })).toBeTruthy();
    fireEvent.click(briefTourBtn);

    await waitFor(() =>
      expect(exploreSpy).toHaveBeenCalledWith('finding-contradicts', {
        mode: 'brief_tour',
        add_to_wiki: true,
      }),
    );

    // Add to wiki button
    fireEvent.click(screen.getByRole('button', { name: /Add to wiki/i }));
    await waitFor(() =>
      expect(addToWikiSpy).toHaveBeenCalledWith('finding-contradicts', {
        content: 'full_text',
      }),
    );
    unmount();

    // Custom FindingComponent host prop for F3 integration
    const CustomFindingHost = ({ finding, onBack }: FindingHostProps) => (
      <div data-testid="f3-host">
        <span>Hosted: {finding.work.title}</span>
        <button type="button" onClick={onBack}>
          Close host
        </button>
      </div>
    );
    render(<ExploreSection clients={createFakeKb('find')} FindingComponent={CustomFindingHost} />);
    await screen.findByTestId('f3-host');
    expect(screen.getByText(/Hosted: Self-correction in LLMs/i)).toBeTruthy();
  });

  it('passes CSS token lint with zero violations in explore.css', () => {
    const cssPath = resolve(__dirname, 'explore.css');
    const css = readFileSync(cssPath, 'utf8');
    const violations = auditCss(css);
    expect(violations).toEqual({
      hexColors: [],
      fontSizePx: [],
      radiusPx: [],
      rawBoxShadow: [],
      spacingPx: [],
    });
  });
});
