import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { b2State } from '../test/fakeB2';
import { quoteAttrs, readSelectionQuote } from '../ui/Selection';
import { insertToken, serialize } from './editor';

const capture = { stop: vi.fn(async () => ({ wav: new ArrayBuffer(48), seconds: 2 })), cancel: vi.fn() };
vi.mock('./dictation', async (load) => ({
  ...(await load<typeof import('./dictation')>()),
  startCapture: vi.fn(async () => capture),
}));

const ready = async () => {
  await within(screen.getByRole('region', { name: 'Chats' })).findByRole('region', { name: 'Pinned' });
  return screen.getByTestId('message-input');
};
const sentBody = (calls: Array<{ method: string; path: string; body?: unknown }>) =>
  calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path)).at(-1)?.body as Record<string, unknown> | undefined;

describe('Message field', () => {
  beforeEach(() => { capture.stop.mockClear(); capture.cancel.mockClear(); });

  it('@ suggests Wiki · Materials · Chats; the choice becomes a token and is sent as a mention', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const input = await ready();
    await user.click(input);
    await user.keyboard('Explain @Entr');
    const popup = await screen.findByTestId('mention-popup');
    const list = within(popup).getByRole('listbox', { name: 'References' });
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(0));
    expect(within(popup).getByText('Wiki')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('mention-popup')).not.toBeInTheDocument();
    const token = input.querySelector('.kb-token--mention')!;
    expect(token).toHaveTextContent('Entropy');
    expect(token).toHaveAttribute('contenteditable', 'false');
    await user.keyboard('please{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toBeDefined());
    expect(sentBody(fake.calls)).toMatchObject({
      text: 'Explain @Entropy please',
      mentions: [{ type: 'page', id: 'p-entropy', title: 'Entropy' }],
    });
  });

  it('agent picker lists only connected agents as choosable; switching in a chat leaves a record', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const picker = await screen.findByTestId('agent-picker');
    await waitFor(() => expect(picker).toHaveAccessibleName(/Claude Code, claude-opus-5-5/));
    await user.click(picker);
    const menu = await screen.findByRole('menu', { name: 'Agent and model' });
    const hermes = within(menu).getByRole('group', { name: 'Hermes Agent' });
    expect(within(hermes).getByText('not installed')).toBeInTheDocument();
    expect(within(hermes).getByRole('menuitemradio')).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByText('A new agent gets this whole chat as context.')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'gpt-5.6-luna' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'PATCH', path: '/kb/chats/c1', body: { engine: 'codex', model: 'gpt-5.6-luna', effort: 'medium' } })));
    expect(await screen.findByText('Switched to Codex', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effort: Medium' })).toBeInTheDocument();
  });

  it('an agent that can’t answer is refused with its reason; nothing is swapped silently', async () => {
    const user = userEvent.setup();
    const state = b2State();
    state.agents.agents.find((a) => a.id === 'codex')!.state = 'signed_out';
    const { fake } = renderKb({ b2: state });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const picker = await screen.findByTestId('agent-picker');
    await user.click(picker);
    const codex = within(await screen.findByRole('menu')).getByRole('group', { name: 'Codex' });
    await user.click(within(codex).getAllByRole('menuitemradio')[0]!);
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(picker).toHaveAccessibleName(/Claude Code/);
  });

  it('"+" → File: saved to Materials (Inbox) at once, "In wiki" on by default; the message carries its id', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const input = await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'File…' }));
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(chips).getByText('paper.pdf')).toBeInTheDocument();
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/materials/file', body: { path: '/Users/me/Downloads/paper.pdf', folder_id: 'inbox' } })));
    // Settings → Wiki adds files automatically: the switch shows it and can't be turned off here.
    const inWiki = within(chips).getByRole('checkbox', { name: 'In wiki' });
    expect(inWiki).toBeChecked();
    expect(inWiki).toBeDisabled();
    await user.click(input);
    await user.keyboard('Summarise it{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toMatchObject({ attachments: [expect.stringMatching(/^m-new/)] }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('"+" → Paste text: "In wiki" is off by default and switching it on sends the material to the wiki', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const input = await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'Paste text…' }));
    await user.type(await screen.findByLabelText('Any text — it is saved to Materials'), 'Lecture notes about entropy');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    const inWiki = within(chips).getByRole('checkbox', { name: 'In wiki' });
    expect(inWiki).not.toBeChecked();
    await user.click(inWiki);
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/materials/text')).toBe(true));
    await user.click(input);
    await user.keyboard('Check{Enter}');
    await waitFor(() => expect(fake.calls.some((c) => /\/kb\/materials\/m-new\d+\/ingest/.test(c.path))).toBe(true));
  });

  it('"+" → Link refuses anything but http(s)', async () => {
    const user = userEvent.setup();
    renderKb({ b2: b2State() });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link…' }));
    await user.type(await screen.findByLabelText('Link to an article or a video'), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('http:// or https://');
  });

  it('dictation: voice → text in the field through bridge.dictate; nothing is sent by itself', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ b2: b2State() });
    const input = await ready();
    const mic = screen.getByRole('button', { name: 'Dictate' });
    await user.click(mic);
    expect(await screen.findByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Listening')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop dictation' }));
    await waitFor(() => expect(input).toHaveTextContent('and how does it relate to a decision tree'));
    expect(fake.bridge.dictate).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'ru');
    expect(sentBody(fake.calls)).toBeUndefined();
  });

  it('a dictation failure is shown in the backend’s words', async () => {
    const user = userEvent.setup();
    const state = b2State();
    state.dictation = { status: 503, detail: 'Speech recognition is not set up.' };
    renderKb({ b2: state });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await user.click(await screen.findByRole('button', { name: 'Stop dictation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dictation: Speech recognition is not set up.');
  });

  it('a quote handed over from a selection becomes a token with its full text on hover and is sent as a quote', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ b2: b2State() });
    const input = await ready();
    act(() => {
      services.composer.getState().push([{ kind: 'quote', quote: { source: 'chat', id: 'c1', message_id: 'c1-a1', text: 'Cross-entropy is Shannon entropy applied to the model’s error' } }], { focus: true });
    });
    const token = await waitFor(() => {
      const t = input.querySelector('.kb-token--quote');
      if (!t) throw new Error('no quote token yet');
      return t;
    });
    expect(token).toHaveTextContent('Cross-entropy is Shannon…');
    expect(token).toHaveAttribute('aria-label', 'AI answer (context, not a source): Cross-entropy is Shannon entropy applied to the model’s error');
    await user.click(input);
    await user.keyboard('why?{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toMatchObject({
      quotes: [{ source: 'chat', id: 'c1', message_id: 'c1-a1', text: 'Cross-entropy is Shannon entropy applied to the model’s error' }],
    }));
  });
});

describe('Editor model', () => {
  it('serialises text and tokens in order; duplicates are one mention', () => {
    const root = document.createElement('div');
    document.body.append(root);
    root.append('Compare ');
    insertToken(root, { kind: 'mention', ref: { type: 'page', id: 'p1', title: 'Entropy' } });
    root.append('with ');
    window.getSelection()?.removeAllRanges();
    insertToken(root, { kind: 'mention', ref: { type: 'page', id: 'p1', title: 'Entropy' } });
    const v = serialize(root);
    expect(v.text).toBe('Compare @Entropy with @Entropy ');
    expect(v.mentions).toEqual([{ type: 'page', id: 'p1', title: 'Entropy' }]);
    root.remove();
  });

  it('a selection inside one quotable element is a quote; across two it is not', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="a">first block text</p><p id="b">second block</p>';
    document.body.append(host);
    const a = host.querySelector('#a') as HTMLElement;
    const b = host.querySelector('#b') as HTMLElement;
    Object.entries(quoteAttrs({ source: 'page', id: 'p1', block_id: 'b1' })).forEach(([k, v]) => a.setAttribute(k, v));
    Object.entries(quoteAttrs({ source: 'page', id: 'p1', block_id: 'b2' })).forEach(([k, v]) => b.setAttribute(k, v));
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(a.firstChild!, 6);
    range.setEnd(a.firstChild!, 11);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(readSelectionQuote(sel)).toEqual({ source: 'page', id: 'p1', block_id: 'b1', seg: null, message_id: null, text: 'block' });
    range.setEnd(b.firstChild!, 3);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(readSelectionQuote(sel)).toBeNull();
    host.remove();
  });
});
