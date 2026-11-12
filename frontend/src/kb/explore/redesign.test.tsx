import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KbSearchPlan } from '../../api/kb/types.gen';
import { KbApiError } from '../api/client';
import { ExploreSection } from './ExploreSection';
import { ExploreMap } from './ExploreMap';
import { children, ex2Kb, mapFixture, roots, runFixture, topic } from './test/fixtures';

const flush = () => act(async () => { await Promise.resolve(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderMap(areas = roots) {
  const onSelectArea = vi.fn();
  return { onSelectArea, ...render(<ExploreMap areas={areas} parentPages={1124} selectedAreaId={null}
    scanning={false} activeAreaIds={[]} justDone={false} onSelectArea={onSelectArea} />) };
}

describe('EX2 own topics from the real-library shape', () => {
  it('weights the map by 93 materials, ignores legacy domains and empty topics, and opens Other without losing small topics', () => {
    const { container, onSelectArea } = renderMap([...roots, topic('empty', 'Empty', 0), topic('old', 'Physical Sciences', 400, { level: 'domain' })]);
    expect(screen.queryByRole('button', { name: /Physical Sciences/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Empty/ })).not.toBeInTheDocument();
    const ai = container.querySelector<HTMLElement>('[data-area-id="ai"]')!;
    const ml = container.querySelector<HTMLElement>('[data-area-id="ml"]')!;
    // Data deliberately disagrees with the page count, the old metric.
    expect(ai).toHaveAccessibleName(/65%/);
    expect(ml).toHaveAccessibleName(/27%/);
    fireEvent.click(screen.getByRole('button', { name: /Other/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mechanics/ }));
    expect(onSelectArea).toHaveBeenCalledWith(roots[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to topics' }));
    expect(screen.getByRole('button', { name: /AI agents/ })).toBeInTheDocument();
  });

  it('uses material proportions even when the smaller topic has most concept pages', () => {
    const { container } = renderMap([topic('one', 'One', 60, { pages: 1 }), topic('two', 'Two', 33, { pages: 1123 })]);
    const area = (id: string) => {
      const el = container.querySelector<HTMLElement>(`[data-area-id="${id}"]`)!;
      return parseFloat(el.style.width) * parseFloat(el.style.height);
    };
    expect(area('one')).toBeGreaterThan(area('two'));
  });

  it('does not start labelling when opening the map, and shows progress after the explicit click', async () => {
    const kb = ex2Kb();
    kb.areas.map.mockResolvedValue(mapFixture({ areas: [], unsorted_materials: 93, labelling: { ...mapFixture().labelling, done: 0 } }));
    render(<ExploreSection clients={kb} />);
    expect(await screen.findByText(/93 materials have no topic yet/)).toBeInTheDocument();
    expect(kb.topics.sort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Organize topics' }));
    expect(await screen.findByText(/0 of 93 materials/)).toBeInTheDocument();
    expect(kb.topics.sort).toHaveBeenCalledTimes(1);
  });

  it('polls stored labelling progress and stops polling while hidden', async () => {
    vi.useFakeTimers();
    const kb = ex2Kb();
    kb.areas.map.mockResolvedValue(mapFixture({ labelling: { state: 'running', job_id: 's', done: 20, total: 93, reason_code: null, engine: 'codex' } }));
    const view = render(<ExploreSection clients={kb} />);
    await flush();
    expect(screen.getByText(/20 of 93 materials/)).toBeInTheDocument();
    kb.areas.map.mockResolvedValue(mapFixture({ labelling: { state: 'running', job_id: 's', done: 40, total: 93, reason_code: null, engine: 'codex' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/40 of 93 materials/)).toBeInTheDocument();
    view.rerender(<ExploreSection clients={kb} hidden />);
    const reads = kb.areas.map.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(kb.areas.map).toHaveBeenCalledTimes(reads);
  });

  it('shows missing wiki engine honestly and opens its settings', async () => {
    const kb = ex2Kb(); const settings = vi.fn();
    kb.areas.map.mockResolvedValue(mapFixture({ areas: [], unsorted_materials: 93, labelling: { ...mapFixture().labelling, state: 'not_ready', reason_code: 'not_ready' } }));
    render(<ExploreSection clients={kb} onOpenSettings={settings} />);
    expect(await screen.findByText(/Set up a wiki engine/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wiki settings' }));
    expect(settings).toHaveBeenCalledWith('wiki');
    expect(kb.topics.sort).not.toHaveBeenCalled();
    expect(screen.queryByText(/Nothing new/)).not.toBeInTheDocument();
  });

  it('drills from topic to subtopic to materials, never displays hidden scientific labels or Worth closing', async () => {
    const kb = ex2Kb(); const openDocument = vi.fn();
    render(<ExploreSection clients={kb} onOpenDocument={openDocument} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI agents/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Agent harnesses/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Local meeting notes/ }));
    expect(openDocument).toHaveBeenCalledWith({ type: 'material', id: 'meeting' });
    expect(screen.queryByText('Worth closing')).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAlex topic|taxonomy|domain-physical/)).not.toBeInTheDocument();
  });
});

describe('EX2 exact search plan and scope', () => {
  it('previews all populated topics and sends only the edited plan on the click', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    await waitFor(() => expect(screen.getByText(/Will search:/)).toHaveTextContent('AI agents'));
    expect(kb.discovery.plan).toHaveBeenCalledWith({ area_id: null, query: '', all_topics: true });
    expect(kb.explore.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit search plan' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search term 1 for AI agents' }), { target: { value: 'agent harnesses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove ML from search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Business communication from search' }));
    fireEvent.click(screen.getByRole('button', { name: "Find what's new" }));
    await waitFor(() => expect(kb.explore.start).toHaveBeenCalledWith({ area_id: null, query: '', all_topics: true,
      plan: [{ area_id: 'ai', label: 'AI agents', terms: ['agent harnesses', 'Harness'] }] }));
  });

  it('keeps an edited preview across temporarily hiding Explore', async () => {
    vi.useFakeTimers();
    const kb = ex2Kb();
    const view = render(<ExploreSection clients={kb} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.click(screen.getByRole('button', { name: 'Edit search plan' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search term 1 for AI agents' }), { target: { value: 'only this edited term' } });
    view.rerender(<ExploreSection clients={kb} hidden />);
    view.rerender(<ExploreSection clients={kb} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByText(/Will search:/)).toHaveTextContent('only this edited term');
    expect(kb.discovery.plan).toHaveBeenCalledTimes(1);
  });

  it('disables empty/all-removed plans with a reason and never starts an empty run', async () => {
    const kb = ex2Kb();
    kb.discovery.plan.mockResolvedValue({ ready: false, reason: 'Choose a topic or enter a query.', items: [] });
    render(<ExploreSection clients={kb} />);
    await screen.findByText('Choose a topic or enter a query.');
    expect(screen.getByRole('button', { name: "Find what's new" })).toBeDisabled();
    expect(kb.explore.start).not.toHaveBeenCalled();
  });

  it('makes unmatched text a precise query inside the chosen topic and rejects a stale preview', async () => {
    const kb = ex2Kb();
    let resolveOld!: (p: KbSearchPlan) => void;
    kb.discovery.plan.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    render(<ExploreSection clients={kb} />);
    await waitFor(() => expect(kb.discovery.plan).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Search scope: All your topics' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search topics or concepts' }), { target: { value: 'harnesses' } });
    fireEvent.click(await screen.findByRole('button', { name: /AI agents › Agent harnesses/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Precise query' }), { target: { value: 'harness' } });
    await waitFor(() => expect(screen.getByText(/Will search:/)).toHaveTextContent('harness'));
    await act(async () => { resolveOld({ ready: true, reason: null, items: [{ area_id: null, label: 'stale', terms: ['WRONG'] }] }); });
    expect(screen.getByText(/Will search:/)).not.toHaveTextContent('WRONG');
    fireEvent.click(screen.getByRole('button', { name: "Find what's new" }));
    await waitFor(() => expect(kb.explore.start).toHaveBeenCalledWith({ area_id: children[0]!.id, query: 'harness', all_topics: false,
      plan: [{ area_id: 'agents', label: 'harness', terms: ['harness'] }] }));
  });

  it('can pick a local concept or use unmatched picker text without changing the chosen topic', async () => {
    const kb = ex2Kb();
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Search scope: All your topics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'AI agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search scope: AI agents' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search topics or concepts' }), { target: { value: 'harness' } });
    fireEvent.click(await screen.findByRole('button', { name: /Concept: Harness evaluation/ }));
    expect(screen.getByRole('textbox', { name: 'Precise query' })).toHaveValue('Harness evaluation');
    expect(screen.getByRole('button', { name: 'Search scope: AI agents' })).toBeInTheDocument();
  });

  it('keeps not_ready separate from an empty successful search', async () => {
    const kb = ex2Kb();
    kb.discovery.plan.mockRejectedValue(new KbApiError(503, 'private provider text', 'not_ready'));
    render(<ExploreSection clients={kb} />);
    expect(await screen.findByText(/Search planning is not ready/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Find what's new" })).toBeDisabled();
    expect(screen.queryByText('private provider text')).not.toBeInTheDocument();
  });
});

describe('EX2 visible funnel', () => {
  it('shows 50 found → 12 fit → 4 new, opens dropped works with reasons and marks It fits without a paid start', async () => {
    const kb = ex2Kb(); const run = runFixture();
    render(<ExploreSection clients={kb} initial={{ run }} />);
    expect(await screen.findByText('50 found → 12 fit → 4 new')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show search candidates' }));
    expect(await screen.findByText('Outside your date rules')).toBeInTheDocument();
    const row = screen.getByRole('article', { name: 'Work no-fit' });
    fireEvent.click(within(row).getByRole('button', { name: 'It fits' }));
    await waitFor(() => expect(kb.discovery.fits).toHaveBeenCalledWith('ex2-run', 'no-fit'));
    expect(kb.explore.start).not.toHaveBeenCalled();
    expect(await screen.findByText(/Marked as fitting. Novelty checks wait for your click/)).toBeInTheDocument();
  });

  it('keeps all 50 works reachable even when no finding survived and supports pagination', async () => {
    const kb = ex2Kb();
    kb.discovery.candidates.mockResolvedValueOnce({ items: [ { ...await kb.discovery.fits('x', 'first'), outcome: 'not_fit', overridden: false } ], next_cursor: 'next' });
    render(<ExploreSection clients={kb} initial={{ run: runFixture({ counters: { ...runFixture().counters, on_topic: 0, new: 0 } }) }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show search candidates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more candidates' }));
    expect(await screen.findByText('Already in your wiki: Agent evaluation')).toBeInTheDocument();
    expect(kb.discovery.candidates).toHaveBeenCalledWith('ex2-run', { cursor: 'next' });
  });
});
