import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Banner, Button, Chip, EmptyState, Icon, ICON_NAMES, ICON_STROKE, Menu, Modal, Segmented, Spinner, Switch, TextField,
} from './index';
import { placePopup } from './geometry';

describe('Icon', () => {
  it('is decorative by default: hidden from assistive tech, Lucide stroke 1.25', () => {
    const { container } = render(<Icon name="settings" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.getAttribute('stroke-width')).toBe(String(ICON_STROKE));
    expect(ICON_STROKE).toBe(1.25);
    expect(svg).toHaveAttribute('width', '16');
  });

  it('is announced only when it carries meaning on its own', () => {
    render(<Icon name="warning" label="Needs attention" size={20} />);
    const img = screen.getByRole('img', { name: 'Needs attention' });
    expect(img).not.toHaveAttribute('aria-hidden');
    expect(img).toHaveAttribute('width', '20');
  });

  it('maps every concept to a drawn glyph (no empty icons), the gear is "settings"', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.children.length, name).toBeGreaterThan(0);
      unmount();
    }
    const { container } = render(<Icon name="settings" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('lucide-settings');
  });
});

function ModalHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      <button type="button">Behind</button>
      <Modal open={open} onClose={() => { onClose?.(); setOpen(false); }} title="Example">
        <div>
          <button type="button">First</button>
          <input aria-label="Middle" />
          <button type="button">Last</button>
        </div>
      </Modal>
    </div>
  );
}

describe('Modal', () => {
  it('moves focus inside, traps Tab in both directions, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Example' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // First focusable is the header's close button.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Last' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Last' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    // Focus is back on the opener immediately, not after the exit animation.
    expect(opener).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('makes the background inert while open and releases it on close', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModalHarness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await screen.findByRole('dialog');
    expect(container.closest('body > *')).toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(container.closest('body > *')).not.toHaveAttribute('inert');
  });

  it('closes on a scrim click unless the dialog forbids it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Pinned" dismissOnScrim={false} dismissOnEscape={false} testId="m"><p>Body</p></Modal>);
    await user.click(screen.getByTestId('m-scrim'));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Banner', () => {
  it('announces errors as alerts and the rest as status, with the icon hidden', () => {
    const { rerender } = render(<Banner tone="error" title="Couldn’t download.">No space left.</Banner>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t download. No space left.');
    expect(alert.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Banner tone="warning" title="Model isn’t downloaded." />);
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'warning');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows real progress only when a value is given', () => {
    const { rerender } = render(<Banner tone="progress" title="Downloading — 42%." progress={42} progressLabel="Download" />);
    const bar = screen.getByRole('progressbar', { name: 'Download' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    rerender(<Banner tone="progress" title="Downloading." />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('Switch and Segmented', () => {
  it('Switch toggles with Space and Enter and reports its state', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Computer audio" checked={on} onChange={setOn} />;
    }
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Computer audio' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.tab();
    expect(sw).toHaveFocus();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('a disabled Switch does not change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="Later" checked={false} disabled onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Segmented is a radiogroup; arrows move the choice', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a');
      return <Segmented label="Theme" value={v} onChange={setV}
        options={[{ value: 'a', label: 'System' }, { value: 'b', label: 'Light' }, { value: 'c', label: 'Dark' }]} />;
    }
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    // Focus follows the choice at once (not a frame later): the next arrow starts from it.
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveFocus();
  });

  it('Segmented arrows skip disabled options and keep focus on the chosen one', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a');
      return <Segmented label="Mode" value={v} onChange={setV}
        options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two', disabled: true }, { value: 'c', label: 'Three' }]} />;
    }
    render(<Harness />);
    await user.tab();
    for (const [key, name] of [['{ArrowRight}', 'Three'], ['{ArrowRight}', 'One'], ['{ArrowLeft}', 'Three'], ['{ArrowDown}', 'One']] as const) {
      await user.keyboard(key);
      expect(screen.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name })).toHaveFocus();
    }
  });
});

describe('Other primitives', () => {
  it('Button variants and busy state keep their label', () => {
    render(<><Button variant="fill">Next</Button><Button variant="danger" busy>Delete</Button></>);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveClass('kb-btn--fill');
    const del = screen.getByRole('button', { name: 'Delete' });
    expect(del).toHaveClass('kb-btn--danger');
    expect(del).toHaveAttribute('aria-busy', 'true');
  });

  it('Chip names the source type in words, not by an emoji', () => {
    render(<><Chip kind="recording" label="Lecture 5" meta="44:00" /><Chip kind="document" label="Textbook" meta="p. 31" onClick={() => undefined} /></>);
    expect(screen.getByLabelText('Recording: Lecture 5, 44:00')).toHaveTextContent('Lecture 544:00');
    expect(screen.getByRole('button', { name: 'Document: Textbook, p. 31' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}▶]/u);
  });

  it('TextField links its error to the input', () => {
    render(<TextField label="Folder name" error="An item with this name already exists." />);
    const input = screen.getByLabelText('Folder name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('An item with this name already exists.');
  });

  it('Spinner and EmptyState speak plainly', () => {
    render(<><Spinner label="Reading the library" /><EmptyState icon="chats" title="No chats yet">Later.</EmptyState></>);
    expect(screen.getByRole('status')).toHaveTextContent('Reading the library');
    expect(screen.getByText('No chats yet')).toBeInTheDocument();
  });

  it('Menu: arrows move, Enter chooses, Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={ref} type="button" onClick={() => setOpen(true)}>Actions</button>
          <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} label="Folder"
            items={[{ id: 'r', label: 'Rename', onSelect: rename }, { id: 'd', label: 'Delete', disabled: true, onSelect: vi.fn() }]} />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Folder' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await screen.findByRole('menu');
    await user.keyboard('{Enter}');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('popups are pulled back inside their column', () => {
    const bounds = { left: 100, top: 0, right: 400, bottom: 600 };
    expect(placePopup({ left: 350, top: 10, right: 380, bottom: 40 }, { width: 200, height: 100 }, 'bottom-start', bounds))
      .toEqual({ left: 192, top: 46 });
    expect(placePopup({ left: 110, top: 560, right: 140, bottom: 590 }, { width: 120, height: 100 }, 'bottom-start', bounds).top)
      .toBe(454);
  });
});

describe('EngineBadge (v42 colour brand marks)', () => {
  it('shows the bundled brand mark, not letters; decorative by default, named on request; sizes 16/20/32', async () => {
    const { EngineBadge } = await import('./EngineBadge');
    const { container } = render(
      <>
        <EngineBadge engine="codex" size={16} />
        <EngineBadge engine="claude_code" />
        <EngineBadge engine="hermes" size={32} label />
      </>,
    );
    const badges = Array.from(container.querySelectorAll<HTMLElement>('.kb-engine'));
    expect(badges.map((b) => b.textContent)).toEqual(['', '', '']);
    expect(container.textContent).not.toMatch(/Cx|CC|\bH\b/);
    const srcs = badges.map((b) => b.querySelector('img')!.getAttribute('src') ?? '');
    expect(srcs[0]).toMatch(/codex\.svg|^data:image\/svg/);
    expect(srcs[1]).toMatch(/claude-code\.svg|^data:image\/svg/);
    expect(srcs[2]).toMatch(/hermes\.png|^data:image\/png/);
    for (const src of srcs) expect(src).not.toMatch(/^https?:/); // bundled, never fetched (CSP)
    expect(badges.map((b) => b.style.getPropertyValue('--kb-engine-size'))).toEqual(['16px', '20px', '32px']);
    // Decorative: hidden with an empty alt; labelled: one image with the agent's name.
    expect(badges[0]).toHaveAttribute('aria-hidden', 'true');
    expect(badges[0]!.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Hermes Agent' })).toBe(badges[2]);
  });
});
