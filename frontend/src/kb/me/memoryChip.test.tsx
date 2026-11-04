import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { chatMessage, type FakeWorld } from '../test/fakeKb';
import { createFakeBridge } from '../test/fakeBridge';
import { agentEdit, freshMe } from '../test/fakeMe';
import type { KbMessagePart } from '../../api/kb/types.gen';
import { createServices, KbServicesProvider } from '../state/context';
import { COMPACTED_NOTE, SystemMessage, plainText, toBlocks } from '../chat/Message';
import { memoryChipText } from './api';
import type { KbMemoryPart } from '../../api/kb/types.gen';

const side = () => screen.getByRole('region', { name: 'Chats' });

/** Chat c1 with an answer in which the agent remembered something (and updated a skill of the user's). */
function rememberedWorld(): FakeWorld {
  const w = chatWorld();
  w.me = freshMe();
  w.me.skills.push({
    id: 'sources', kind: 'skill', builtin: false, title: 'Favourite sources', description: 'Where you read first', enabled: true,
    always_on: false, limit: null, versions: [],
  });
  const remembered = agentEdit(w, { edit_id: 'ed-1', skill_id: 'how-to-work', text: 'Prefers an example first.', summary: 'prefers an example first', chat_id: 'c1' });
  const updated = agentEdit(w, { edit_id: 'ed-2', skill_id: 'sources', text: 'Feynman first.', summary: '+ Feynman first', action: 'replace', chat_id: 'c1' });
  const c1 = w.chats.find((c) => c.id === 'c1')!;
  c1.messages.push(
    chatMessage('c1-u2', 3, 'user', c1.updated_at, [{ type: 'text', text: 'Give me an example first, always.' }]),
    chatMessage('c1-a2', 4, 'assistant', c1.updated_at, [
      { type: 'text', text: 'Noted. Here is an example: ' },
      remembered as unknown as KbMessagePart,
      { type: 'text', text: 'a coin toss has one bit of entropy.' },
      updated as unknown as KbMessagePart,
    ]),
  );
  c1.cursor = 4;
  return w;
}

describe('Chat: an agent’s edit of «Я» is a chip with Undo (N6 decision 7)', () => {
  it('chip text: «Remembered: …» for an addition to a built-in, «Updated skill "…"» otherwise', () => {
    const part = (p: Partial<KbMemoryPart>): KbMemoryPart => ({
      type: 'memory', edit_id: 'e', skill_id: 'profile', skill_title: 'Profile', action: 'append', summary: 'exam in January', undone: false, ...p,
    });
    expect(memoryChipText(part({}))).toBe('Remembered: exam in January');
    expect(memoryChipText(part({ skill_id: 'how-to-work', action: 'create' }))).toBe('Remembered: exam in January');
    expect(memoryChipText(part({ skill_id: 'search', action: 'append' }))).toBe('Remembered: exam in January');
    expect(memoryChipText(part({ action: 'replace' }))).toBe('Updated skill “Profile”');
    expect(memoryChipText(part({ skill_id: 'exam-style', skill_title: 'Exam style', action: 'append' }))).toBe('Updated skill “Exam style”');
    expect(memoryChipText(part({ skill_id: 'exam-style', skill_title: 'Exam style', action: 'delete' }))).toBe('Updated skill “Exam style”');
  });

  it('a memory part is its own block, never an inline chip, and stays out of Copy', () => {
    const memory = { type: 'memory', edit_id: 'e', skill_id: 'profile', skill_title: 'Profile', action: 'append', summary: 's', undone: false };
    const parts = [{ type: 'text', text: 'A ' }, memory, { type: 'text', text: 'B' }] as unknown as KbMessagePart[];
    expect(toBlocks(parts).map((b) => b.kind)).toEqual(['inline', 'memory', 'inline']);
    expect(plainText(parts)).toBe('A B');
  });

  it('renders in the answer; Undo calls the undo route and the chip reads Undone (also after the feed’s copy)', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: rememberedWorld() });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const chip = await within(centre).findByRole('group', { name: 'Remembered: prefers an example first' });
    expect(chip).toHaveTextContent('Remembered: prefers an example first');
    const other = within(centre).getByRole('group', { name: 'Updated skill “Favourite sources”' });
    expect(within(other).getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await user.click(within(chip).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/me/edits/ed-1/undo' })));
    const undone = await within(centre).findByRole('group', { name: 'Undone: Remembered: prefers an example first' });
    expect(undone).toHaveTextContent('Undone');
    expect(within(undone).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    // The backend restored the version before the edit (the fake's «Я» follows the same contract).
    expect(fake.world.me!.skills.find((s) => s.id === 'how-to-work')!.versions.at(-1)!.text).toBe('');
    // The other chip is untouched.
    expect(within(centre).getByRole('group', { name: 'Updated skill “Favourite sources”' })).toBeInTheDocument();
  });

  it('an Undo the backend refuses says why and keeps the Undo button', async () => {
    const user = userEvent.setup();
    const world = rememberedWorld();
    world.failures['POST /kb/me/edits/ed-1/undo'] = { status: 409, detail: 'This change was already undone.' };
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const chip = await within(centre).findByRole('group', { name: 'Remembered: prefers an example first' });
    await user.click(within(chip).getByRole('button', { name: 'Undo' }));
    expect(await within(chip).findByRole('alert')).toHaveTextContent('This change was already undone.');
    expect(within(chip).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('a part the backend already marked undone shows Undone with no button', async () => {
    const user = userEvent.setup();
    const world = rememberedWorld();
    const part = world.chats.find((c) => c.id === 'c1')!.messages.at(-1)!.parts[1] as unknown as KbMemoryPart;
    part.undone = true;
    renderKb({ world });
    await user.click(await within(side()).findByRole('button', { name: /Why is there a logarithm/ }));
    const centre = screen.getByRole('region', { name: 'Chat' });
    const chip = await within(centre).findByRole('group', { name: 'Undone: Remembered: prefers an example first' });
    expect(within(chip).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

describe('Chat: "History compressed" is a thin divider (N6 decision 13)', () => {
  const system = (text: string) => chatMessage('s1', 5, 'system', '2026-10-26T10:00:00Z', [{ type: 'text', text }], { engine: 'codex', model: null });
  const services = () => createServices(createFakeBridge(chatWorld()).bridge, null, { capture: null });

  it('the compaction notice renders as a separator line, not a note', () => {
    render(<KbServicesProvider services={services()}><SystemMessage chatId="c1" message={system(COMPACTED_NOTE)} /></KbServicesProvider>);
    const line = screen.getByRole('separator', { name: 'History compressed' });
    expect(line).toHaveClass('kb-msg--divider');
    expect(line).toHaveTextContent('History compressed');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('other system records stay notes with the agent badge', () => {
    render(<KbServicesProvider services={services()}><SystemMessage chatId="c1" message={system('Switched to Codex')} /></KbServicesProvider>);
    expect(screen.getByRole('note')).toHaveTextContent('Switched to Codex');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});
