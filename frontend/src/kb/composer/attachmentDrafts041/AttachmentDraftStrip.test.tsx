import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '../../ui/Popover';
import { MotionProvider } from '../../ui/motion';
import { AttachmentDraftStrip } from './AttachmentDraftStrip';
import type { DraftAttachment } from './draft';

function attachment(key: string, more: Partial<DraftAttachment> = {}): DraftAttachment {
  return {
    key, name: `${key}.docx`, source: 'file', state: 'ready', materialId: key,
    error: null, inWiki: false, materialReady: true, ...more,
  };
}

function Harness({ initial }: { initial: DraftAttachment[] }) {
  const [items, setItems] = useState(initial);
  return <AttachmentDraftStrip
    items={items}
    onRemove={(key) => setItems((list) => list.filter((item) => item.key !== key))}
    onToggleWiki={(key) => setItems((list) => list.map((item) => item.key === key ? { ...item, inWiki: !item.inWiki } : item))}
  />;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('attachment draft strip', () => {
  it('shows two attachments, prioritizes failures and lets the user act on every file from overflow', () => {
    render(<Harness initial={[
      attachment('first'), attachment('second'), attachment('third', { alreadyInLibrary: true }),
      attachment('broken', { state: 'failed', materialId: null, error: 'The file is empty.' }),
    ]} />);
    const strip = within(screen.getByRole('list', { name: 'Draft attachments' }));
    expect(strip.getByTitle('broken.docx')).toBeVisible();
    expect(strip.queryByTitle('second.docx')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('broken.docx: The file is empty. Remove or replace before sending.');

    fireEvent.click(strip.getByRole('button', { name: 'Show all 4 attachments' }));
    const list = within(screen.getByRole('dialog', { name: 'Attachments' }));
    expect(list.getAllByRole('listitem')).toHaveLength(4);
    const second = list.getByText('second.docx').closest('li')!;
    fireEvent.click(within(second).getByRole('checkbox', { name: 'In wiki' }));
    expect(within(second).getByRole('checkbox', { name: 'In wiki' })).toBeChecked();
    expect(list.getByText('Already in your library')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: 'Remove broken.docx' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    expect(list.getByText('first.docx')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('returns focus to the overflow trigger when its dialog closes', async () => {
    render(<Harness initial={[attachment('first'), attachment('second'), attachment('third')]} />);
    const trigger = screen.getByRole('button', { name: 'Show all 3 attachments' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Attachments' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps focus on the overflow trigger when Escape exposes the exiting file menu under the pointer', () => {
    function ComposerAttachments() {
      const [menu, setMenu] = useState(true);
      const anchor = useRef<HTMLButtonElement>(null);
      return <>
        <button ref={anchor} type="button">Add a file</button>
        <Menu open={menu} onClose={() => setMenu(false)} anchorRef={anchor} label="Add to the question"
          items={[{ id: 'file', label: 'File…', onSelect: () => {} }]} />
        <Harness initial={[attachment('first'), attachment('second'), attachment('third')]} />
      </>;
    }
    render(<MotionProvider><ComposerAttachments /></MotionProvider>);
    const file = screen.getByRole('menuitem', { name: 'File…' });
    fireEvent.click(file);

    const trigger = screen.getByRole('button', { name: 'Show all 3 attachments' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: 'Attachments' }));
    const close = dialog.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(trigger).toHaveFocus();

    expect(file).toBeInTheDocument();
    fireEvent.pointerOver(file);
    expect(trigger).toHaveFocus();
  });

  it('moves focus back to the strip if the overflow trigger was removed', async () => {
    render(<Harness initial={[attachment('first'), attachment('second'), attachment('third')]} />);
    const trigger = screen.getByRole('button', { name: 'Show all 3 attachments' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Attachments' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove third.docx' }));
    expect(trigger).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove first.docx' })).toHaveFocus());
  });

  it('creates a local thumbnail URL and releases it when its attachment leaves the strip', async () => {
    const createObjectURL = vi.fn(() => 'blob:test-preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const thumbnail = new Blob(['preview fixture'], { type: 'image/png' });
    const { container } = render(<Harness initial={[attachment('chart', { name: 'chart.png', thumbnail })]} />);
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:test-preview'));
    expect(createObjectURL).toHaveBeenCalledWith(thumbnail);
    fireEvent.click(screen.getByRole('button', { name: 'Remove chart.png' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });
});
