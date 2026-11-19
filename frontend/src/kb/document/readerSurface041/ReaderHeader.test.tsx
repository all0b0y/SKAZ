import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderHeader } from './ReaderHeader';

describe('ReaderHeader', () => {
  it('expands and collapses only on activation and keeps focus on the same control', async () => {
    const toggle = vi.fn();
    function Reader() {
      const [expanded, setExpanded] = useState(false);
      return <ReaderHeader typeLabel="Material" expanded={expanded} onClose={vi.fn()}
        onToggleExpanded={() => { toggle(); setExpanded((previous) => !previous); }} />;
    }
    const user = userEvent.setup();
    render(<Reader />);

    const expand = screen.getByRole('button', { name: 'Expand to the centre' });
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    await user.tab();
    expect(expand).toHaveFocus();
    expect(toggle).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Back to side panel' })).toBe(expand);
    expect(expand).toHaveAttribute('aria-pressed', 'true');
    expect(expand).toHaveFocus();

    await user.keyboard(' ');
    expect(expand).toHaveAccessibleName('Expand to the centre');
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    expect(expand).toHaveFocus();
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('keeps back, reader actions, menu and close in keyboard order', async () => {
    const back = vi.fn();
    const readNotes = vi.fn();
    const openMenu = vi.fn();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <ReaderHeader typeLabel="Notes" expanded={false} onBack={back} onClose={close} closeLabel="Close source"
        actions={<button type="button" onClick={readNotes}>Read notes</button>}
        onToggleExpanded={vi.fn()}
        more={<button type="button" aria-haspopup="menu" onClick={openMenu}>Material actions</button>}
      />,
    );
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('kb-reader-header');
    expect(within(header).getByText('Notes')).toBeVisible();
    for (const name of ['Back', 'Read notes', 'Expand to the centre', 'Material actions', 'Close source']) {
      await user.tab();
      expect(within(header).getByRole('button', { name })).toHaveFocus();
    }

    for (const [label, action] of [
      ['Back', back], ['Read notes', readNotes], ['Material actions', openMenu], ['Close source', close],
    ] as const) {
      await user.click(within(header).getByRole('button', { name: label }));
      expect(action).toHaveBeenCalledOnce();
    }
  });

  it('handles the history shortcut only when back is available', () => {
    const back = vi.fn();
    const close = vi.fn();
    const { rerender } = render(<ReaderHeader typeLabel="Wiki" expanded={false} onBack={back} onClose={close} />);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-keyshortcuts', 'Meta+BracketLeft');
    expect(screen.queryByRole('button', { name: 'Expand to the centre' })).not.toBeInTheDocument();

    expect(fireEvent.keyDown(window, { key: '[', metaKey: true })).toBe(false);
    expect(fireEvent.keyDown(window, { key: '[', ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(window, { key: '[', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(back).toHaveBeenCalledTimes(2);

    rerender(<ReaderHeader typeLabel="Wiki" expanded={false} onClose={close} />);
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(window, { key: '[', metaKey: true })).toBe(true);
    expect(back).toHaveBeenCalledTimes(2);
  });
});
