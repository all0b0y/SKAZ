import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
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
    const { fake } = renderKb({ world: chatWorld() });
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
    const { fake } = renderKb({ world: chatWorld() });
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
    const state = chatWorld();
    state.agents.agents.find((a) => a.id === 'codex')!.state = 'signed_out';
    const { fake } = renderKb({ world: state });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
    const picker = await screen.findByTestId('agent-picker');
    await user.click(picker);
    const codex = within(await screen.findByRole('menu')).getByRole('group', { name: 'Codex' });
    await user.click(within(codex).getAllByRole('menuitemradio')[0]!);
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(picker).toHaveAccessibleName(/Claude Code/);
  });

  it('@ with several words keeps narrowing; words that match nothing are just text (QA D8)', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const input = await ready();
    await user.click(input);
    await user.keyboard('@Lecture 8');
    const popup = await screen.findByTestId('mention-popup');
    await waitFor(() => expect(within(popup).getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Lecture 8')])));
    await waitFor(() => expect(within(popup).getAllByRole('option').every((o) => /lecture 8/i.test(o.textContent ?? ''))).toBe(true));
    await user.keyboard('{Enter}');
    expect(input.querySelector('.kb-token--mention')).toHaveTextContent(/Lecture 8/);
    await user.keyboard(' @Lecture zzz');
    await waitFor(() => expect(screen.queryByTestId('mention-popup')).not.toBeInTheDocument());
  });

  it('a mentioned material deleted before sending: the token is marked deleted and the message isn’t sent with it (QA B8)', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: chatWorld() });
    const input = await ready();
    await user.click(input);
    await user.keyboard('Explain ');
    act(() => services.composer.getState().push([{ kind: 'mention', ref: { type: 'material', id: 'm1', title: 'Lecture 8 — entropy' } }]));
    await waitFor(() => expect(input.querySelector('.kb-token--mention')).not.toBeNull());
    const token = input.querySelector<HTMLElement>('.kb-token--mention')!;
    expect(token).toHaveAccessibleName('Reference: Lecture 8 — entropy');
    await act(async () => { await services.library.getState().forgetMaterial('m1'); });
    expect(token).toHaveClass('is-gone');
    expect(token).toHaveAccessibleName('Reference: Lecture 8 — entropy (deleted)');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('“Lecture 8 — entropy” was deleted. Remove it from the message to send.')).toBeInTheDocument();
    expect(sentBody(fake.calls)).toBeUndefined();
  });

  it('each chat keeps its own unsent draft; a hand-off that opens New chat lands in its field (QA D2/D3)', async () => {
    const user = userEvent.setup();
    const w = chatWorld();
    const { services } = renderKb({ world: w });
    const input = await ready();
    const [a, b] = [w.chats[0]!.id, w.chats[1]!.id];
    act(() => services.chats.getState().open(a));
    await user.click(input);
    await user.keyboard('draft in A');
    act(() => services.chats.getState().open(b));
    expect(input).toHaveTextContent(/^$/);
    act(() => services.chats.getState().open(a));
    expect(input).toHaveTextContent('draft in A');
    // "Ask the agent about this": New chat opens and the text is handed over in the same tick.
    act(() => {
      services.chats.getState().open(null);
      services.composer.getState().push([{ kind: 'text', text: 'handed over' }], { focus: true });
    });
    await waitFor(() => expect(input).toHaveTextContent('handed over'));
    expect(input).not.toHaveTextContent('draft in A');
  });

  it('no agent: the reason is next to the field with the way to fix it (QA D6)', async () => {
    const user = userEvent.setup();
    const w = chatWorld();
    w.agents.default = 'hermes';
    const { services, fake } = renderKb({ world: w });
    const input = await ready();
    await user.click(input);
    await user.keyboard('Why?{Enter}');
    const error = await screen.findByText(/Hermes Agent can’t answer now: Hermes Agent isn’t installed\./);
    expect(input).toHaveTextContent('Why?');
    expect(fake.calls.some((c) => c.method === 'POST' && /\/messages$/.test(c.path))).toBe(false);
    await user.click(within(error).getByRole('button', { name: 'Install in Settings…' }));
    expect(services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'conn' });
  });

  it('"+" → File: saved to Materials (Inbox) at once and held; "In wiki" on from Settings, sent at send; the message carries its id', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const input = await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'File…' }));
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(chips).getByText('paper.pdf')).toBeInTheDocument();
    // Held out of the wiki until the message is sent: the switch decides then (decision 15).
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/materials/file', body: { path: '/Users/me/Downloads/paper.pdf', folder_id: 'inbox', to_wiki: false } })));
    // Settings → Wiki add files automatically: that is the default, and it stays switchable.
    const inWiki = within(chips).getByRole('checkbox', { name: 'In wiki' });
    expect(inWiki).toBeChecked();
    expect(inWiki).toBeEnabled();
    await user.click(input);
    await user.keyboard('Summarise it{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toMatchObject({ attachments: [expect.stringMatching(/^m-new/)] }));
    await waitFor(() => expect(fake.calls.some((c) => /\/kb\/materials\/m-new\d+\/ingest/.test(c.path))).toBe(true));
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('"+" → File with Settings adding files automatically: unticking "In wiki" keeps it out of the wiki', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const input = await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'File…' }));
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/materials/file')).toBe(true));
    await user.click(within(chips).getByRole('checkbox', { name: 'In wiki' }));
    expect(within(chips).getByRole('checkbox', { name: 'In wiki' })).not.toBeChecked();
    await user.click(input);
    await user.keyboard('Summarise it{Enter}');
    await waitFor(() => expect(sentBody(fake.calls)).toMatchObject({ attachments: [expect.stringMatching(/^m-new/)] }));
    expect(fake.calls.some((c) => /\/ingest$/.test(c.path))).toBe(false);
  });

  it('"+" → Paste text: "In wiki" is off by default and switching it on sends the material to the wiki', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
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
    renderKb({ world: chatWorld() });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
    await user.click(screen.getByRole('menuitem', { name: 'Link…' }));
    const field = await screen.findByLabelText('Link to an article or a video');
    // Our own message, never the browser's validation bubble in the system language (QA D14).
    expect(field.closest('form')).toHaveAttribute('novalidate');
    await user.type(field, 'not a link at all');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('http:// or https://');
    await user.clear(field);
    await user.type(field, 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('http:// or https://');
  });

  it('the agent picker names the agent once when it has no model of its own (QA D13)', async () => {
    const w = chatWorld();
    w.agents.default = 'codex';
    Object.assign(w.agents.agents.find((a) => a.id === 'codex')!, { models: [], current_model: null });
    renderKb({ world: w });
    await ready();
    await waitFor(() => expect(screen.getByTestId('agent-picker')).toHaveAccessibleName('Agent and model: Codex'));
  });

  it('dictation: voice → text in the field through bridge.dictate; nothing is sent by itself', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
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
    const state = chatWorld();
    state.dictation = { status: 503, detail: 'Speech recognition is not set up.' };
    renderKb({ world: state });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await user.click(await screen.findByRole('button', { name: 'Stop dictation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dictation: Speech recognition is not set up.');
  });

  it('a quote handed over from a selection becomes a token with its full text on hover and is sent as a quote', async () => {
    const user = userEvent.setup();
    const { fake, services } = renderKb({ world: chatWorld() });
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
