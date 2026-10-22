import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbCitation } from '../../../api/kb/types.gen';
import type { KbMaterialSummary } from '../../../api/kb/types.gen';
import { createServices, KbServicesProvider } from '../../state/context';
import { MotionProvider } from '../../ui';
import { Toast } from '../../ui/Toast';
import { SourceMarks, SourcesRow } from '../../cite/SourceMarks';
import { indexSources } from '../../cite/sources';
import { WikiCell } from '../../materials/AllMaterials';
import { createFakeBridge, docWorld } from '../../test/fakeBridge';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';
import { ChipStipple } from './ChipStipple';
import { StippleStrip } from './StippleStrip';
import { ToastStipple } from './ToastStipple';

const cit: KbCitation = {
  material_id: 's1', seg: 1, available: true, material_title: 'Seminar', start_ms: null, end_ms: null, page: 1, quote: 'A quote.',
};

function withServices(ui: React.ReactNode) {
  const services = createServices(createFakeBridge(chatWorld()).bridge, null, { capture: null });
  return render(<KbServicesProvider services={services}><MotionProvider>{ui}</MotionProvider></KbServicesProvider>);
}

describe('Citation chip stippling', () => {
  it('no canvas at rest; hover shows an aria-hidden, text-free canvas inside the chip; it goes away after leaving', async () => {
    const user = userEvent.setup();
    withServices(<p>Claim<SourceMarks citations={[cit]} /></p>);
    const mark = screen.getByRole('button', { name: 'Source 1: Seminar' });
    expect(mark.querySelector('canvas')).toBeNull();
    await user.hover(mark);
    const cv = mark.querySelector('canvas.kb-fx-stip--chip');
    expect(cv).not.toBeNull();
    expect(cv).toHaveAttribute('aria-hidden', 'true');
    expect(mark.textContent).toBe('1'); // the chip's own text is untouched
  });

  it('after the pointer leaves, the canvas stays while the dots settle and then goes (fake timers)', () => {
    vi.useFakeTimers();
    try {
      withServices(<p>Claim<SourceMarks citations={[cit]} /></p>);
      const mark = screen.getByRole('button', { name: 'Source 1: Seminar' });
      fireEvent.mouseEnter(mark);
      expect(mark.querySelector('canvas.kb-fx-stip--chip')).not.toBeNull();
      fireEvent.mouseLeave(mark);
      act(() => { vi.advanceTimersByTime(200); }); // the popup's close delay (160 ms) has passed
      expect(mark.querySelector('canvas')).not.toBeNull(); // still settling (450 ms)
      act(() => { vi.advanceTimersByTime(500); });
      expect(mark.querySelector('canvas')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('works on the Sources row items too, and keyboard focus counts as hover', async () => {
    const user = userEvent.setup();
    withServices(<SourcesRow index={indexSources([cit])} />);
    const item = screen.getByRole('button', { name: 'Source 1: Seminar' });
    expect(item.querySelector('canvas')).toBeNull();
    await user.tab();
    expect(item).toHaveFocus();
    expect(item.querySelector('canvas.kb-fx-stip--chip')).not.toBeNull();
  });

  it('ChipStipple renders nothing while off', () => {
    const { container } = render(<ChipStipple on={false} />);
    expect(container.querySelector('canvas')).toBeNull();
  });
});

describe('Progress strip', () => {
  it('is an aria-hidden block with one canvas', () => {
    const { container } = render(<StippleStrip />);
    const strip = container.querySelector('.kb-stipstrip')!;
    expect(strip).toHaveAttribute('aria-hidden', 'true');
    expect(strip.querySelectorAll('canvas.kb-fx-stip--strip')).toHaveLength(1);
    expect(strip.textContent).toBe('');
  });

  const material = (over: Partial<KbMaterialSummary>) => ({ id: 'm', status: 'ready', wiki_state: 'in_wiki', ...over }) as KbMaterialSummary;

  it.each([
    [{ status: 'processing' }, 'Processing…'],
    [{ status: 'recording' }, 'Recording…'],
    [{ status: 'ready', wiki_state: 'queued' }, 'Queued'],
    [{ status: 'ready', wiki_state: 'processing' }, 'Adding…'],
  ] as const)('the Wiki cell of %j shows the label and the strip, and no spinner', (over, text) => {
    const { container } = render(<WikiCell material={material(over)} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelectorAll('.kb-stipstrip')).toHaveLength(1);
    expect(container.querySelector('.kb-spinner')).toBeNull(); // one indicator per status: the strip
  });

  it.each([
    [{ wiki_state: 'in_wiki' }],
    [{ wiki_state: 'not_in_wiki' }],
    [{ wiki_state: 'failed' }],
    [{ status: 'failed' }],
    [{ wiki_state: 'paused' }],
  ] as const)('the Wiki cell of %j has no strip (not running)', (over) => {
    const { container } = render(<WikiCell material={material(over)} />);
    expect(container.querySelector('.kb-stipstrip')).toBeNull();
  });

  it('the material view shows one strip while a job runs', async () => {
    const r = renderKb({ world: docWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-l5' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const pipe = await within(doc).findByLabelText('Processing');
    const label = await within(pipe).findByText('Writing notes');
    expect(pipe.querySelectorAll('.kb-stipstrip')).toHaveLength(1);
    expect(pipe.querySelector('.kb-spinner')).toBeNull(); // the strip replaces the pill's spinner
    expect(label.closest('[role="status"]')).not.toBeNull(); // the words stay a live status
  });
});

describe('Toast stippling', () => {
  const toast = { id: 1, text: 'Added to the wiki', tone: 'done' as const };
  const view = (t: { id: number; text: string; tone?: 'done' | 'problem' }) =>
    <MotionProvider><Toast toast={t} onClose={() => undefined} /></MotionProvider>;

  it('a good-news toast carries the shimmer canvas (aria-hidden) outside its text, and it ends by itself', () => {
    vi.useFakeTimers();
    try {
      render(view(toast));
      const el = screen.getByTestId('toast');
      const cv = el.querySelector('canvas.kb-fx-stip--toast');
      expect(cv).not.toBeNull();
      expect(cv).toHaveAttribute('aria-hidden', 'true');
      expect(el.querySelector('.kb-toast__text')!.contains(cv)).toBe(false);
      expect(el).toHaveTextContent('Added to the wiki');
      act(() => { vi.advanceTimersByTime(1300); });
      expect(el.querySelector('canvas')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a problem toast stays plain', () => {
    render(view({ ...toast, tone: 'problem' }));
    expect(screen.getByTestId('toast').querySelector('canvas')).toBeNull();
  });

  it('a neutral toast (no tone: «Already pinned», «Nothing new to mark») stays plain', () => {
    render(view({ id: 1, text: 'Already pinned' }));
    expect(screen.getByTestId('toast').querySelector('canvas')).toBeNull();
  });

  it('plays once per toast: it ends, and the NEXT done toast plays it again', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(view(toast));
      expect(screen.getByText('Added to the wiki').closest('[data-testid="toast"]')!.querySelector('canvas')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1300); });
      expect(document.querySelector('[data-testid="toast"] canvas')).toBeNull(); // played once, gone
      rerender(view({ id: 2, text: 'Moved 2 materials', tone: 'done' }));
      const next = screen.getByText('Moved 2 materials').closest('[data-testid="toast"]')!;
      expect(next.querySelector('canvas.kb-fx-stip--toast')).not.toBeNull(); // replayed on the new toast
    } finally {
      vi.useRealTimers();
    }
  });

  it('ToastStipple alone mounts one canvas', () => {
    const { container } = render(<ToastStipple />);
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
  });
});
