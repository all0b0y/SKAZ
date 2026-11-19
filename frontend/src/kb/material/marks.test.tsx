// F5: N3 paragraph marks, read marks, N1 marks on a material and the wiki "outdated" footnote — every
// state of N4 v4 states 15, 16 and 20–24 on the fake client's scenes. The fake answers contract shapes;
// the real routes are the backend's to prove.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeKb, type FakeKb } from '../api/fake';
import { contractFixtures as f } from '../api/fake/fixtures';
import { scenes, type SceneName } from '../api/fake/scenes';
import type { KbCitation, KbFreshnessMark, KbMaterialRepeats } from '../../api/kb/types.gen';
import { createFakeBridge, docWorld } from '../test/fakeBridge';
import { fragment } from '../test/fakeKb';
import { createServices, KbServicesProvider } from '../state/context';
import { MotionProvider } from '../ui';
import { MarksClientsProvider } from './marksClients';
import { MaterialView } from './MaterialView';
import { OutdatedFootnote, PageFreshnessProvider, marksForBlock } from './OutdatedFootnote';
import { repeatSpots } from './RepeatMarks';

afterEach(() => cleanup());

const MATERIAL = 'm-ce';

function world() {
  const w = docWorld();
  const m = w.materials.find((x) => x.id === MATERIAL)!;
  m.fragments = [
    fragment(MATERIAL, 1, 'Retrieval-augmented generation combines a language model with retrieved material.'),
    fragment(MATERIAL, 2, 'What changes when the collection evolves? A source may be revised after it has been indexed.'),
    fragment(MATERIAL, 3, 'Keep citations attached to the passages that support each claim.'),
  ];
  return w;
}

function repeats(partial: Partial<KbMaterialRepeats> = {}): KbMaterialRepeats {
  const lecture = { material_id: 'm-lec7', title: 'Lecture 7' };
  const paragraph = (id: string, seg: number, full = true) => ({
    paragraph_id: id, fragment_ids: [seg], wiki_refs: [], from_materials: [lecture],
    repeated_statements: full ? 1 : 1, total_statements: full ? 1 : 3, fully_repeated: full,
  });
  return { ...f.KbMaterialRepeats, material_id: MATERIAL, status: 'checked', percent: 80, from_materials: [lecture],
    paragraphs: [paragraph('p1', 1), paragraph('p3', 3, false)], ...partial };
}

function mount(scene: SceneName | undefined, edit?: (kb: FakeKb) => void) {
  const kb = createFakeKb(scene);
  edit?.(kb);
  const bridge = createFakeBridge(world());
  const services = createServices(bridge.bridge, null, { capture: null });
  const view = render(
    <KbServicesProvider services={services}>
      <MotionProvider>
        <MarksClientsProvider clients={{ repeats: kb.repeats, areas: kb.areas, maintenance: kb.maintenance, freshness: kb.freshness }}>
          <MaterialView target={{ type: 'material', id: MATERIAL }} nonce={0} />
        </MarksClientsProvider>
      </MotionProvider>
    </KbServicesProvider>,
  );
  return { kb, bridge, services, view, user: userEvent.setup() };
}

describe('N3 marks in the material (v4 states 15–16)', () => {
  it('marks a passage the wiki already has, with the source it is from', async () => {
    mount(undefined, (kb) => { kb.repeats.material = async () => repeats(); });
    const labels = await screen.findAllByTestId('repeat-label');
    expect(labels[0]).toHaveTextContent('Already in your wiki · from Lecture 7');
    expect(within(labels[0]!).getByRole('button', { name: 'Lecture 7' })).toBeInTheDocument();
    // a passage only partly repeated is not called repeated
    expect(labels[1]).toHaveTextContent('Partly in your wiki · 1 of 3 statements');
    expect(screen.getByText(/What changes when the collection evolves/)).toBeInTheDocument();
  });

  it('Hide what you’ve read folds fully repeated passages with a way back, and unchecking restores them', async () => {
    const { user } = mount(undefined, (kb) => { kb.repeats.material = async () => repeats(); });
    const toggle = await screen.findByRole('checkbox', { name: 'Hide what you\'ve read' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    const folded = await screen.findByTestId('repeat-folded');
    expect(folded).toHaveTextContent('Repeated passage hidden · Show');
    expect(folded).toHaveTextContent('Already in your wiki · from Lecture 7');
    expect(screen.queryByText(/Retrieval-augmented generation combines/)).not.toBeInTheDocument();
    // the partly repeated passage stays readable
    expect(screen.getByText(/Keep citations attached/)).toBeInTheDocument();
    await user.click(within(folded).getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/Retrieval-augmented generation combines/)).toBeInTheDocument();
    expect(screen.queryByTestId('repeat-folded')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it('shows no marks and no toggle for a material that was not checked for repeats', async () => {
    mount('not_checked');
    await screen.findByRole('heading', { level: 2, name: 'Cross-entropy explained' });
    await waitFor(() => expect(screen.getByText(/Retrieval-augmented generation combines/)).toBeInTheDocument());
    expect(screen.queryByTestId('repeat-label')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Hide what/ })).not.toBeInTheDocument();
  });

  it('maps paragraph fragment ids onto fragments (the first one carries the label)', () => {
    const fragments = [fragment('m', 1, 'a'), fragment('m', 2, 'b'), fragment('m', 3, 'c')];
    const spots = repeatSpots(repeats({ paragraphs: [{ ...repeats().paragraphs[0]!, fragment_ids: [2, 3] }] }), fragments);
    expect([...spots.keys()]).toEqual([2, 3]);
    expect(spots.get(2)!.first).toBe(true);
    expect(spots.get(3)!.first).toBe(false);
    expect(repeatSpots(repeats({ status: 'not_checked' }), fragments).size).toBe(0);
  });
});

describe('read marks at the end of a material (N4-11)', () => {
  it('sets, changes and removes the one mark', async () => {
    const { kb, user } = mount(undefined, (k) => {
      k.areas.read_mark = vi.fn(async () => ({ material_id: MATERIAL, finding_id: null, value: 'already_knew' as const, updated_at: null }));
      k.areas.set_read_mark = vi.fn(async (_id, body) => ({ material_id: MATERIAL, finding_id: null, value: body.value, updated_at: null }));
      k.areas.remove_read_mark = vi.fn(async () => ({ material_id: MATERIAL, finding_id: null, value: null, updated_at: null }));
    });
    const group = await screen.findByRole('group', { name: 'Your read mark' });
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Already knew this' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Useful method', 'Changed my view', 'Already knew this', 'Not for me']);
    await user.click(within(group).getByRole('button', { name: 'Useful method' }));
    expect(kb.areas.set_read_mark).toHaveBeenCalledWith(MATERIAL, { value: 'useful_method' });
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Useful method' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(group).getByRole('button', { name: 'Already knew this' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(group).getByRole('button', { name: 'Useful method' }));
    expect(kb.areas.remove_read_mark).toHaveBeenCalledWith(MATERIAL);
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Useful method' })).toHaveAttribute('aria-pressed', 'false'));
  });

  it('says so when a mark cannot be saved', async () => {
    const { user } = mount(undefined, (k) => { k.areas.set_read_mark = async () => { throw new Error('The mark was not saved.'); }; });
    await user.click(await screen.findByRole('button', { name: 'Not for me' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The mark was not saved.');
  });
});

describe('N1 marks on a material (v4 states 20–23)', () => {
  const withMark = (kb: FakeKb, mark: KbFreshnessMark) => {
    kb.maintenance.act = vi.fn(async (_id, body) => ({ mark: { ...mark, kept_marked: body.action === 'keep_marked' }, ingest_job_id: body.action === 'replace_version' ? 'job-1' : null }));
  };

  it('a newer version: the reason, where it comes from, and Replace with v3', async () => {
    const { kb, user } = mount('new_version', (k) => withMark(k, scenes.new_version.freshness.marks[0]!));
    expect(await screen.findByText('v3 is out (2026)')).toBeInTheDocument();
    expect(screen.getByText(/arXiv version history · checked/)).toBeInTheDocument();
    // 11/A: the mark block keeps its place below the head; the manual entry point stays in the
    // actions row — one button, not a second one inside the freshness block.
    expect(screen.getAllByRole('button', { name: 'Check links' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Check links' }).closest('.kb-mat__actions')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Delete source/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace with v3' }));
    expect(kb.maintenance.act).toHaveBeenCalledWith('mark-version', { action: 'replace_version' });
    expect(await screen.findByText(/Replacing with v3/)).toBeInTheDocument();
  });

  it('a retraction: only the claims held by this source say so; Keep, marked keeps the warning', async () => {
    const { kb, user } = mount('retracted', (k) => withMark(k, scenes.retracted.freshness.marks[0]!));
    expect(await screen.findByText('Retracted (2026)')).toBeInTheDocument();
    expect(screen.getByText('Crossref · checked', { exact: false })).toBeInTheDocument();
    const claims = screen.getByRole('region', { name: 'Claims using this source' });
    expect(within(claims).getByText('Retracted source · only supporting source')).toBeInTheDocument();
    expect(within(claims).getByText('Also supported by Lecture 7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete source…' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep, marked' }));
    expect(kb.maintenance.act).toHaveBeenCalledWith('mark-retracted', { action: 'keep_marked' });
    expect(await screen.findByText(/Kept · the warning stays/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep, marked' })).not.toBeInTheDocument();
  });

  it('Delete source… opens the existing delete confirmation, not a new route', async () => {
    const { user } = mount('retracted');
    await user.click(await screen.findByRole('button', { name: 'Delete source…' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a link that is gone: the copy is kept; only Keep is offered', async () => {
    const { kb, user } = mount('link_gone', (k) => withMark(k, scenes.link_gone.freshness.marks[0]!));
    expect(await screen.findByText('Original link is gone · your copy is kept')).toBeInTheDocument();
    expect(screen.getByText('Not found on two checks, one day apart.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace|Delete/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(kb.maintenance.act).toHaveBeenCalledWith('mark-gone', { action: 'keep_marked' });
  });

  it('a timeout is a check result, not a mark; Check links runs a manual check', async () => {
    const { kb, user } = mount('couldnt_check', (k) => {
      k.freshness.check_links = vi.fn(async () => ({ ...scenes.couldnt_check.linkCheck, state: 'done' as const }));
    });
    expect(await screen.findByText('Link check: couldn’t check')).toBeInTheDocument();
    expect(screen.getByText('The site did not respond. Your source has not been marked as outdated.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check links' }));
    expect(kb.freshness.check_links).toHaveBeenCalledWith({ material_ids: [MATERIAL] });
  });

  it('Check links sits beside Write notes in one actions row; no empty freshness floor (11/A)', async () => {
    const { kb, user } = mount(undefined, (k) => {
      k.maintenance.marks = vi.fn(async () => ({ marks: [], last_link_check: null }));
      k.freshness.check_links = vi.fn(async () => ({ ...scenes.couldnt_check.linkCheck, state: 'done' as const }));
    });
    const write = await screen.findByRole('button', { name: 'Write notes' });
    const check = await screen.findByRole('button', { name: 'Check links' });
    // One compact row under the status chips, Write notes first (11/A: the manual link check joins
    // the notes action; the freshness block no longer holds a right-aligned bar of its own).
    const row = check.closest('.kb-mat__actions')!;
    expect(write.closest('.kb-mat__actions')).toBe(row);
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Write notes', 'Check links']);
    // Nothing to report: the block itself is absent, so no empty tier sits between the actions
    // and the transcript tabs.
    expect(screen.queryByTestId('freshness')).not.toBeInTheDocument();
    await user.click(check);
    expect(kb.freshness.check_links).toHaveBeenCalledWith({ material_ids: [MATERIAL] });
  });

  it('keeps the narrow-width contract (11/A): no bar rule in the freshness styles, the actions row wraps', () => {
    // jsdom cannot measure the material panel; the CSS is the narrow-width guarantee: the actions
    // wrap instead of clipping, and the freshness block owns no right-aligned bar floor any more.
    const marksCss = fs.readFileSync(path.resolve(__dirname, 'marks.css'), 'utf8');
    expect(marksCss).not.toMatch(/kb-freshwrap__bar/);
    const documentCss = fs.readFileSync(path.resolve(__dirname, '../styles/document.css'), 'utf8');
    expect(documentCss.match(/\.kb-mat__actions\s*{[^}]*}/)?.[0]).toMatch(/flex-wrap:\s*wrap/);
  });

  it('shows no block and no Check links for a material without marks and without an original link', async () => {
    const bridge = createFakeBridge(world());
    bridge.world.materials.find((x) => x.id === MATERIAL)!.origin = null;
    const kb = createFakeKb();
    kb.maintenance.marks = async () => ({ marks: [], last_link_check: null });
    render(
      <KbServicesProvider services={createServices(bridge.bridge, null, { capture: null })}>
        <MotionProvider>
          <MarksClientsProvider clients={{ ...kb }}>
            <MaterialView target={{ type: 'material', id: MATERIAL }} nonce={0} />
          </MarksClientsProvider>
        </MotionProvider>
      </KbServicesProvider>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Cross-entropy explained' });
    expect(screen.queryByTestId('freshness')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check links' })).not.toBeInTheDocument();
    // The notes action stays even when the link cannot be checked.
    expect(screen.getByRole('button', { name: 'Write notes' })).toBeInTheDocument();
  });

  it('polls a running link check until it is done, then reads the marks again', async () => {
    let polls = 0;
    const { kb, user } = mount('couldnt_check', (k) => {
      k.freshness.check_links = vi.fn(async () => ({ ...scenes.couldnt_check.linkCheck, id: 'check-9', state: 'running' as const }));
      k.freshness.link_check = vi.fn(async () => ({ ...scenes.couldnt_check.linkCheck, id: 'check-9', state: (++polls > 1 ? 'done' : 'running') as 'done' | 'running' }));
    });
    await user.click(await screen.findByRole('button', { name: 'Check links' }));
    expect(await screen.findByText('Checking the link…')).toBeInTheDocument();
    await waitFor(() => expect(kb.freshness.link_check).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByText('Checking the link…')).not.toBeInTheDocument(), { timeout: 2000 });
  });

  it('a failed check from the actions row says so in the freshness block; the entry point recovers', async () => {
    const { kb, user } = mount(undefined, (k) => {
      k.maintenance.marks = vi.fn(async () => ({ marks: [], last_link_check: null }));
      k.freshness.check_links = vi.fn(async () => { throw new Error('The site did not respond.'); });
    });
    const check = await screen.findByRole('button', { name: 'Check links' });
    await user.click(check);
    const block = await screen.findByTestId('freshness');
    expect(within(block).getByRole('alert')).toHaveTextContent('The site did not respond.');
    // Not stuck busy: the entry point recovers and the check can be retried.
    expect(check).toBeEnabled();
    await user.click(check);
    expect(kb.freshness.check_links).toHaveBeenCalledTimes(2);
  });

  it('an interrupted check says it stopped and offers the retry', async () => {
    const { user } = mount(undefined, (k) => {
      k.maintenance.marks = vi.fn(async () => ({ marks: [], last_link_check: null }));
      k.freshness.check_links = vi.fn(async () => ({ ...scenes.couldnt_check.linkCheck, state: 'paused' as const }));
    });
    await user.click(await screen.findByRole('button', { name: 'Check links' }));
    expect(await screen.findByText('The link check stopped. Check links again to retry.')).toBeInTheDocument();
  });
});

describe('outdated footnote in the wiki (v4 state 24)', () => {
  const citation = (material_id: string): KbCitation => ({ material_id, seg: 1, available: true, material_title: 'Retrieval evaluation', start_ms: null, end_ms: null, page: null });
  const mark = scenes.footnote.freshness.marks[0]!;

  function page(blockId: string, material = mark.material_id) {
    const kb = createFakeKb('footnote');
    const services = createServices(createFakeBridge().bridge, null, { capture: null });
    const open = vi.spyOn(services.ui.getState(), 'openDocument');
    render(
      <KbServicesProvider services={services}>
        <MotionProvider>
          <MarksClientsProvider clients={{ maintenance: kb.maintenance }}>
            <PageFreshnessProvider pageId="page-eval">
              <OutdatedFootnote pageId="page-eval" blockId={blockId} citations={[citation(material)]} />
            </PageFreshnessProvider>
          </MarksClientsProvider>
        </MotionProvider>
      </KbServicesProvider>,
    );
    return { kb, services, open, user: userEvent.setup() };
  }

  it('marks the statement; hover shows the reason and a way to the material', async () => {
    const { user } = page('block-1');
    const marker = await screen.findByRole('button', { name: /Source outdated: v3 is out \(2026\)/ });
    await user.hover(marker);
    const pop = await screen.findByRole('dialog', { name: 'Source outdated' });
    expect(pop).toHaveTextContent('Retrieval evaluation · outdated');
    expect(pop).toHaveTextContent('v3 is out (2026)');
    expect(pop).toHaveTextContent('Your citation uses v2.');
    expect(within(pop).getByRole('button', { name: 'Open material' })).toBeInTheDocument();
  });

  it('is reachable by keyboard focus and Escape closes it', async () => {
    const { user } = page('block-1');
    const marker = await screen.findByRole('button', { name: /Source outdated/ });
    await user.tab();
    expect(marker).toHaveFocus();
    expect(await screen.findByRole('dialog', { name: 'Source outdated' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Source outdated' })).not.toBeInTheDocument());
  });

  it('shows nothing on a statement the mark does not touch, or whose citation is another material', async () => {
    page('block-2');
    page('block-1', 'material-other');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Source outdated/ })).not.toBeInTheDocument());
  });

  it('joins on material and block; link-gone marks never become a footnote', () => {
    const marks = [mark, { ...mark, id: 'gone', kind: 'link_gone' as const }];
    expect(marksForBlock(marks, 'page-eval', 'block-1', [citation(mark.material_id)]).map((m) => m.id)).toEqual([mark.id]);
    expect(marksForBlock(marks, 'page-eval', 'block-9', [citation(mark.material_id)])).toEqual([]);
    expect(marksForBlock(marks, 'other-page', 'block-1', [citation(mark.material_id)])).toEqual([]);
  });
});
