import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ITEMS_MIME } from '../../ui/listSelection/dnd';
import { ExternalAttachmentDropOverlay, useExternalAttachmentBoundary } from './boundary';
import { createAttachmentDraftStore, useAttachmentDraft, type AttachmentDraftStore, type AttachmentIntake } from './draft';

const picture = new File(['fixture'], 'chart.png', { type: 'image/png' });

function transfer(types: string[], files: File[] = []) {
  return { types, files, dropEffect: 'none' };
}

function Harness({
  chatId, store, intake, onText, onInternal,
}: {
  chatId: string | null;
  store: AttachmentDraftStore;
  intake: AttachmentIntake;
  onText: (text: string) => void;
  onInternal: () => void;
}) {
  const { paneHandlers, over, handlePaste } = useExternalAttachmentBoundary({
    chatId, store, intake, inWiki: false,
  });
  const { attachments } = useAttachmentDraft(store, chatId);
  return <>
    <section aria-label="Chat" {...paneHandlers}>
      <div role="log">History</div>
      <div
        role="textbox"
        onDrop={(event) => { if (event.dataTransfer.types.includes(ITEMS_MIME)) onInternal(); }}
        onPaste={(event) => { if (!handlePaste(event)) onText(event.clipboardData.getData('text/plain')); }}
      />
      <output aria-label="Draft size">{attachments.length}</output>
      <ExternalAttachmentDropOverlay visible={over} />
    </section>
    <aside aria-label="Sidebar" />
  </>;
}

function mount(chatId: string | null = 'chat-a') {
  const store = createAttachmentDraftStore();
  const intake = vi.fn<AttachmentIntake>(async () => ({ id: 'from-intake', ready: true }));
  const onText = vi.fn();
  const onInternal = vi.fn();
  const props = { chatId, store, intake, onText, onInternal };
  return { ...render(<Harness {...props} />), props, store, intake, onText, onInternal };
}

describe('external attachment boundary', () => {
  it('accepts external files over the history and leaves sidebar and internal drops available', () => {
    const { intake, onInternal } = mount();
    const log = screen.getByRole('log');
    expect(fireEvent.drop(screen.getByRole('complementary'), { dataTransfer: transfer(['Files'], [picture]) })).toBe(true);
    expect(fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: transfer([ITEMS_MIME, 'Files'], [picture]) })).toBe(true);
    expect(onInternal).toHaveBeenCalledOnce();
    expect(intake).not.toHaveBeenCalled();

    expect(fireEvent.dragOver(log, { dataTransfer: transfer(['Files']) })).toBe(false);
    expect(screen.getByText('Drop files to attach')).toBeVisible();
    expect(fireEvent.drop(log, { dataTransfer: transfer(['Files'], [picture]) })).toBe(false);
    expect(intake).toHaveBeenCalledExactlyOnceWith({ source: 'drop', file: picture });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('keeps text paste available, including when the clipboard also contains an image', () => {
    const { intake, onText } = mount();
    const editor = screen.getByRole('textbox');
    const clipboard = (text: string, items: object[]) => ({
      getData: (type: string) => type === 'text/plain' ? text : '', items, files: [],
    });
    const images = [{ kind: 'file', type: 'image/png', getAsFile: () => picture }];
    expect(fireEvent.paste(editor, { clipboardData: clipboard('ordinary', []) })).toBe(true);
    expect(intake).not.toHaveBeenCalled();
    expect(fireEvent.paste(editor, { clipboardData: clipboard('with image', images) })).toBe(true);
    expect(fireEvent.paste(editor, { clipboardData: clipboard('', images) })).toBe(false);
    expect(intake.mock.calls).toEqual([[{ source: 'clipboard', file: picture }], [{ source: 'clipboard', file: picture }]]);
    expect(onText.mock.calls).toEqual([['ordinary'], ['with image']]);
  });

  it('cancels on Escape, ignores a drop after switching chats and accepts a fresh drag', () => {
    const { intake, rerender, props, store } = mount();
    const log = screen.getByRole('log');
    const begin = () => fireEvent.dragOver(log, { dataTransfer: transfer(['Files']) });
    const drop = () => fireEvent.drop(log, { dataTransfer: transfer(['Files'], [picture]) });
    begin();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Drop files to attach')).toBeNull();
    begin();
    drop();
    expect(intake).not.toHaveBeenCalled();

    begin();
    rerender(<Harness {...props} chatId="chat-b" />);
    expect(screen.queryByText('Drop files to attach')).toBeNull();
    drop();
    expect(intake).not.toHaveBeenCalled();
    begin();
    drop();
    expect(intake).toHaveBeenCalledOnce();
    expect(store.getState().getDraft('chat-a').attachments).toEqual([]);
    expect(screen.getByLabelText('Draft size')).toHaveTextContent('1');
    rerender(<Harness {...props} />);
    expect(screen.getByLabelText('Draft size')).toHaveTextContent('0');
    rerender(<Harness {...props} chatId="chat-b" />);
    expect(screen.getByLabelText('Draft size')).toHaveTextContent('1');
  });

  it('clears the overlay on pane exit but keeps it when moving between descendants', () => {
    mount();
    const log = screen.getByRole('log');
    fireEvent.dragOver(log, { dataTransfer: transfer(['Files']) });
    fireEvent(log, new MouseEvent('dragleave', { bubbles: true, relatedTarget: screen.getByRole('textbox') }));
    expect(screen.getByText('Drop files to attach')).toBeVisible();
    fireEvent(log, new MouseEvent('dragleave', { bubbles: true, relatedTarget: screen.getByRole('complementary') }));
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('accepts a fresh OS drag after a cancelled drag leaves without a drop or dragend', () => {
    const { intake, props, rerender } = mount();
    const log = screen.getByRole('log');
    const dataTransfer = transfer(['Files'], [picture]);
    fireEvent.dragOver(log, { dataTransfer });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(log, new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }));
    rerender(<Harness {...props} chatId="chat-b" />);
    // Chromium reports entry from outside as a DragEvent with a null related target.
    const entry = new MouseEvent('dragenter', { bubbles: true, relatedTarget: null });
    Object.defineProperty(entry, 'dataTransfer', { value: dataTransfer });
    fireEvent(log, entry);
    fireEvent.dragOver(log, { dataTransfer });
    fireEvent.drop(log, { dataTransfer });
    expect(intake).toHaveBeenCalledOnce();
  });
});
