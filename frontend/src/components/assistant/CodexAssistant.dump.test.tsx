/**
 * Not a behaviour test: dumps real CodexAssistant markup (open chat, streaming
 * task with journal, queue, pending note edit) from the authored contract
 * fixture so scripts/codex-ui.smoke.spec.ts can lay it out with the built CSS
 * in Electron. Runs only when AUDIOHELPER_CODEX_DUMP is set.
 */
import { expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';
import { stopCodexPolling } from '../../state/codex';
import { fakeCodex } from '../../test/codexFake';

const out = process.env.AUDIOHELPER_CODEX_DUMP;

it.runIf(Boolean(out))('dumps the Codex assistant', async () => {
  const fake = fakeCodex();
  Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true, value: fake.bridge });
  fake.chats.push(
    { id: 'c1', session_id: 's1', title: 'Бюджет и сроки проекта на следующий квартал', scope: 'group', group_id: 'g', revoked: false, unread: false, updated_at: '2' },
    { id: 'c2', session_id: 's1', title: 'Термины', scope: 'session', group_id: null, revoked: false, unread: true, updated_at: '1' },
  );
  fake.selected.s1 = 'c1';
  fake.messages.c1 = [
    { id: 'u1', role: 'user', content: 'Что решили по бюджету?', created_at: 't' },
    { id: 'a1', role: 'assistant', content: 'Бюджет — **10 млн** [P1].', created_at: 't',
      citations: [{ segment_id: 'x', start_ms: 65000, end_ms: 70000, text: 'Бюджет фиксируем.', labels: ['P1'] }] },
    { id: 'u2', role: 'user', content: 'Сравни с прошлой лекцией', created_at: 't' },
  ];
  fake.tasks.push(
    { id: 't1', chat_id: 'c1', session_ids: ['s1'], question: 'Сравни с прошлой лекцией', model: 'gpt-x', status: 'running',
      snapshot_id: 's', answer: 'В прошлой лекции резерв **не** обсуждали, сейчас…', error: null, kind: 'chat', note_id: null,
      citations: [], activity: ['Читаю «Лекция 1» 00:00–05:00', 'Ищу «резерв» в группе'] },
    { id: 't2', chat_id: '', session_ids: ['s2'], question: '', model: 'gpt-x', status: 'queued', snapshot_id: null,
      answer: '', error: null, kind: 'notes', note_id: null, citations: [], activity: [] },
  );
  fake.notes.push({ id: 'n1', revision: 2, content: 'x', title: 'Итоги', created_at: 't', model: 'm', citations: [] });
  fake.previews.push({ id: 'p1', chat_id: 'c1', session_id: 's1', note_id: 'n1', expected_revision: 2,
    original: 'a', replacement: 'b', status: 'pending' });
  useStore.setState({
    ready: true, activeSessionId: 's1', askContext: null,
    sessions: [{ id: 's1', title: 'Лекция 1', created_at: 't', status: 'stopped', duration_ms: 1, mode: 'legacy' },
      { id: 's2', title: 'Лекция 2', created_at: 't', status: 'stopped', duration_ms: 1, mode: 'legacy' }],
    detail: { segments: [], messages: [], notes: null, notes_list: [{ ...fake.notes[0]! }] },
  });
  const { container } = render(<AssistantPanel onCite={() => undefined} />);
  await waitFor(() => expect(screen.getByTestId('codex-preview')).toBeTruthy());
  stopCodexPolling();
  // Popovers are portalled to <body> (PANES-SPEC §1): dump them after the panel
  // markup so the layout fixture still sees their content.
  const withPortals = () => container.innerHTML + [...document.body.children]
    .filter((el) => el !== container).map((el) => el.outerHTML).join('');
  const base = withPortals();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Queue · 2/ }));
  const queue = withPortals();
  await user.click(screen.getByRole('button', { name: /Queue · 2/ }));
  await user.click(screen.getByRole('button', { name: 'Бюджет и сроки проекта на следующий квартал' }));
  const picker = withPortals();
  await act(async () => undefined);
  fs.mkdirSync(out!, { recursive: true });
  fs.writeFileSync(path.join(out!, 'codex-assistant.html'), base);
  fs.writeFileSync(path.join(out!, 'codex-queue.html'), queue);
  fs.writeFileSync(path.join(out!, 'codex-picker.html'), picker);
  stopCodexPolling();
});
