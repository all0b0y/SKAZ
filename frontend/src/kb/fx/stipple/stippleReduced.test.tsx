import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbCitation } from '../../../api/kb/types.gen';
import { createServices, KbServicesProvider } from '../../state/context';
import { MotionProvider } from '../../ui';
import { Toast } from '../../ui/Toast';
import { SourceMarks } from '../../cite/SourceMarks';
import { createFakeBridge } from '../../test/fakeBridge';
import { chatWorld } from '../../test/fixtures';
import { StippleStrip } from './StippleStrip';
import { StippleGlobe, StippleRing } from './StippleWork';

// prefers-reduced-motion: reduce — set before Motion first reads it (this file only).
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
}));

const cit: KbCitation = {
  material_id: 's1', seg: 1, available: true, material_title: 'Seminar', start_ms: null, end_ms: null, page: 1, quote: 'A quote.',
};

describe('Stippling with reduced motion', () => {
  it.each([['ring', StippleRing], ['globe', StippleGlobe]] as const)('%s remains as a still frame with the system preference', (_name, Indicator) => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<Indicator />);
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
  it('no chip effect on hover', async () => {
    const user = userEvent.setup();
    const services = createServices(createFakeBridge(chatWorld()).bridge, null, { capture: null });
    render(<KbServicesProvider services={services}><MotionProvider><p>Claim<SourceMarks citations={[cit]} /></p></MotionProvider></KbServicesProvider>);
    const mark = screen.getByRole('button', { name: 'Source 1: Seminar' });
    await user.hover(mark);
    expect(mark).toHaveAttribute('aria-expanded', 'true');
    expect(mark.querySelector('canvas')).toBeNull();
  });

  it('no toast effect', () => {
    render(<MotionProvider><Toast toast={{ id: 1, text: 'Added to the wiki' }} onClose={() => undefined} /></MotionProvider>);
    expect(screen.getByTestId('toast').querySelector('canvas')).toBeNull();
  });

  it('the strip stays (a still frame, no loop)', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<StippleStrip />);
    expect(container.querySelectorAll('canvas.kb-fx-stip--strip')).toHaveLength(1);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});
