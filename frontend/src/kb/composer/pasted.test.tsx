import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { isLongPaste, LONG_PASTE, pastedName } from './PastedText';

const ready = async () => {
  await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
  return screen.getByTestId('message-input');
};
const paste = (input: HTMLElement, text: string) => fireEvent.paste(input, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
type Call = { method: string; path: string; body?: unknown };
const sentBody = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path)).at(-1)?.body as Record<string, unknown> | undefined;
const textAdds = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path === '/kb/materials/text');

const long = (n: number) => 'x'.repeat(n);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('Long paste becomes an attachment', () => {
  it('threshold: up to the limit stays text, one more becomes a card (characters and lines)', () => {
    expect(isLongPaste(long(LONG_PASTE.chars))).toBe(false);
    expect(isLongPaste(long(LONG_PASTE.chars + 1))).toBe(true);
    expect(isLongPaste(lines(LONG_PASTE.lines))).toBe(false);
    expect(isLongPaste(lines(LONG_PASTE.lines + 1))).toBe(true);
    expect(isLongPaste(`${lines(LONG_PASTE.lines)}\n`)).toBe(false); // a trailing newline is not a line
    expect(pastedName(long(12_400))).toBe('Pasted text · 12,400 characters');
  });

  it('a short paste goes into the field as plain text; a long one becomes a card and the field stays empty', async () => {
    renderKb({ world: chatWorld() });
    const input = await ready();
    paste(input, long(LONG_PASTE.chars));
    expect(input.textContent).toBe(long(LONG_PASTE.chars));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();

    input.replaceChildren();
    fireEvent.input(input);
    paste(input, lines(LONG_PASTE.lines + 1));
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    const size = lines(LONG_PASTE.lines + 1).length.toLocaleString('en-US');
    expect(within(chips).getByRole('button', { name: `Show the pasted text (${size} characters)` })).toHaveTextContent(`Pasted text · ${size} characters`);
    expect(input.textContent).toBe('');
  });

  it('send: the card becomes a pasted-text material only now, "In wiki" off by default, the message carries it', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const input = await ready();
    const text = `Notes on entropy.\n\n${long(2_500)}`;
    paste(input, text);
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    const inWiki = within(chips).getByRole('checkbox', { name: 'In wiki' });
    expect(inWiki).not.toBeChecked();
    expect(inWiki).toBeEnabled();
    expect(textAdds(fake.calls)).toHaveLength(0); // nothing saved until the message goes
    await user.click(input);
    await user.keyboard('Summarise it{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toMatchObject({ text: 'Summarise it', attachments: [expect.stringMatching(/^m-new/)] }));
    expect(textAdds(fake.calls).map((c) => c.body)).toEqual([{ text, folder_id: 'inbox', to_wiki: false }]);
    expect(fake.calls.some((c) => /\/ingest$/.test(c.path))).toBe(false);
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('send with "In wiki" ticked sends the pasted material to the wiki', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const input = await ready();
    paste(input, long(3_000));
    await user.click(within(await screen.findByRole('list', { name: 'Attachments' })).getByRole('checkbox', { name: 'In wiki' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.calls.some((c) => /\/kb\/materials\/m-new\d+\/ingest$/.test(c.path))).toBe(true));
    expect(sentBody(fake.calls)).toMatchObject({ text: '', attachments: [expect.stringMatching(/^m-new/)] });
  });

  it('click on the card shows the text read-only; "Paste as text" puts it back into the field', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const input = await ready();
    const text = `${lines(45)}\nThe end.`;
    paste(input, text);
    const size = text.length.toLocaleString('en-US');
    await user.click(within(await screen.findByRole('list', { name: 'Attachments' })).getByRole('button', { name: `Show the pasted text (${size} characters)` }));
    const preview = await screen.findByRole('dialog', { name: 'Pasted text' });
    const body = within(preview).getByRole('region', { name: 'Pasted text content' });
    expect(body.textContent).toBe(text);
    expect(body).toHaveAttribute('tabindex', '0'); // scrollable by keyboard
    expect(body.querySelector('textarea, [contenteditable="true"]')).toBeNull();
    await user.click(within(preview).getByRole('button', { name: 'Paste as text' }));
    expect(screen.queryByRole('dialog', { name: 'Pasted text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
    expect(input.textContent).toBe(text);
    expect(textAdds(fake.calls)).toHaveLength(0);
  });

  it('"Paste as text" on the card itself does the same', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const input = await ready();
    paste(input, long(2_001));
    await user.click(within(await screen.findByRole('list', { name: 'Attachments' })).getByRole('button', { name: 'Paste as text' }));
    expect(input.textContent).toBe(long(2_001));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('⌘Z right after the paste puts the text into the field; after typing ⌘Z is the editor’s own again', async () => {
    renderKb({ world: chatWorld() });
    const input = await ready();
    input.focus();
    paste(input, long(2_100));
    await screen.findByRole('list', { name: 'Attachments' });
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    expect(input.textContent).toBe(long(2_100));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();

    input.replaceChildren();
    fireEvent.input(input);
    paste(input, long(2_200));
    await screen.findByRole('list', { name: 'Attachments' });
    fireEvent.input(input); // the user typed something after the paste
    const undo = fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(undo).toBe(true); // not taken over: the browser undoes the typing
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeInTheDocument();
  });

  it('the card can be removed by name', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const input = await ready();
    paste(input, long(2_345));
    await user.click(within(await screen.findByRole('list', { name: 'Attachments' })).getByRole('button', { name: 'Remove Pasted text · 2,345 characters' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });
});
