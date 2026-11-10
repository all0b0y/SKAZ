// F5: the library date filter (N7-5): "Looking at YYYY–YYYY", real publication dates from the freshness
// client, and materials without a known date listed apart. The fake answers contract shapes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeKb } from '../api/fake';
import { contractFixtures as f } from '../api/fake/fixtures';
import type { KbAreaMaterial } from '../../api/kb/types.gen';
import { createFakeBridge, docWorld } from '../test/fakeBridge';
import { createServices, KbServicesProvider } from '../state/context';
import { MarksClientsProvider } from '../material/marksClients';
import { MotionProvider } from '../ui';
import { AllMaterials } from './AllMaterials';
import { lastYears, windowDates } from './publicationWindow';

afterEach(() => cleanup());

const dated = (id: string): KbAreaMaterial => ({ ...(f.KbDatedMaterials.materials[0] as KbAreaMaterial), material_id: id });

function mount(edit?: (kb: ReturnType<typeof createFakeKb>) => void) {
  const kb = createFakeKb();
  edit?.(kb);
  const services = createServices(createFakeBridge(docWorld()).bridge, null, { capture: null });
  render(
    <KbServicesProvider services={services}>
      <MotionProvider>
        <MarksClientsProvider clients={{ freshness: kb.freshness }}>
          <AllMaterials hidden={false} />
        </MarksClientsProvider>
      </MotionProvider>
    </KbServicesProvider>,
  );
  return { kb, user: userEvent.setup() };
}

describe('window helpers', () => {
  it('a window of whole years ending this year, asking for unknown dates apart', () => {
    expect(lastYears(3, 2026)).toEqual({ from: 2024, to: 2026 });
    expect(windowDates({ from: 2024, to: 2026 })).toEqual({ from_date: '2024-01-01', to_date: '2026-12-31', unknown: 'separate' });
  });
});

describe('library date filter', () => {
  it('starts with Any time and lists every material', async () => {
    mount();
    const table = await screen.findByRole('grid', { name: 'Materials' });
    expect(within(table).getByRole('button', { name: 'Lecture 8 — entropy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Any time/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Publication date unknown' })).not.toBeInTheDocument();
  });

  it('a chosen window narrows the table to materials published inside it and lists unknown dates apart', async () => {
    const year = new Date().getFullYear();
    const { kb, user } = mount((k) => {
      k.freshness.filter_dates = vi.fn(async () => ({ materials: [dated('m-lec8')], unknown_date: [dated('m-ce')], next_cursor: null }));
    });
    await screen.findByRole('grid', { name: 'Materials' });
    await user.click(screen.getByRole('button', { name: /Any time/ }));
    await user.click(await screen.findByRole('menuitem', { name: new RegExp(`Last 3 years \\(${year - 2}–${year}\\)`) }));
    expect(await screen.findByRole('button', { name: `Looking at ${year - 2}–${year}. Change the publication window` })).toBeInTheDocument();
    expect(kb.freshness.filter_dates).toHaveBeenCalledWith({ dates: { from_date: `${year - 2}-01-01`, to_date: `${year}-12-31`, unknown: 'separate' } });
    const table = screen.getByRole('grid', { name: 'Materials' });
    await waitFor(() => expect(within(table).queryByRole('button', { name: 'Lecture 7 — the second law' })).not.toBeInTheDocument());
    expect(within(table).getByRole('button', { name: 'Lecture 8 — entropy' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Cross-entropy explained' })).not.toBeInTheDocument();
    const apart = screen.getByRole('region', { name: 'Publication date unknown' });
    expect(apart).toHaveTextContent('Publication date unknown · 1');
    expect(within(apart).getByRole('button', { name: 'Cross-entropy explained' })).toBeInTheDocument();
  });

  it('Any time brings every material back', async () => {
    const { user } = mount((k) => {
      k.freshness.filter_dates = async () => ({ materials: [dated('m-lec8')], unknown_date: [], next_cursor: null });
    });
    await screen.findByRole('grid', { name: 'Materials' });
    await user.click(screen.getByRole('button', { name: /Any time/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Last 5 years/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lecture 7 — the second law' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Looking at/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Any time' }));
    expect(await screen.findByRole('button', { name: 'Lecture 7 — the second law' })).toBeInTheDocument();
  });

  it('follows the cursor to the end and says so when the filter cannot be read', async () => {
    const pages = [{ materials: [dated('m-lec8')], unknown_date: [], next_cursor: 'c2' }, { materials: [dated('m-lec7')], unknown_date: [], next_cursor: null }];
    let n = 0;
    const { kb, user } = mount((k) => { k.freshness.filter_dates = vi.fn(async () => pages[n++]!); });
    await screen.findByRole('grid', { name: 'Materials' });
    await user.click(screen.getByRole('button', { name: /Any time/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Last 10 years/ }));
    await waitFor(() => expect(kb.freshness.filter_dates).toHaveBeenCalledTimes(2));
    expect(kb.freshness.filter_dates).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }));
    expect(await screen.findByRole('button', { name: 'Lecture 7 — the second law' })).toBeInTheDocument();

    cleanup();
    const failing = mount((k) => { k.freshness.filter_dates = async () => { throw new Error('No dates yet.'); }; });
    await screen.findByRole('grid', { name: 'Materials' });
    await failing.user.click(screen.getByRole('button', { name: /Any time/ }));
    await failing.user.click(await screen.findByRole('menuitem', { name: /Last 3 years/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t filter by publication date. No dates yet.');
  });
});
