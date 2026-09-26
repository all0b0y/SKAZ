/**
 * Not a behaviour test: dumps the real AssistantPanel markup of a rich answer
 * with footnotes (and an old answer without label records) so
 * scripts/assistant-answer.smoke.spec.ts can lay it out with the built CSS in
 * Electron. Runs only when AUDIOHELPER_ANSWER_DUMP is set.
 */
import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { AssistantPanel } from './AssistantPanel';
import { useStore } from '../../state/store';

const out = process.env.AUDIOHELPER_ANSWER_DUMP;

it.runIf(Boolean(out))('dumps a rich answer', async () => {
  // API engine: the backend fixture does not serve the Codex boundary.
  Object.defineProperty(window, 'audiohelper', { configurable: true, writable: true,
    value: { ...window.audiohelper, request: vi.fn(async () => ({ ok: false, status: 404, detail: 'Not Found' })) } });
  const c = (id: string, label: string, s: number, text: string, extra = {}) =>
    ({ segment_id: id, start_ms: s * 1000, end_ms: s * 1000 + 8000, text, labels: [label], ...extra });
  useStore.setState({
    ready: true, activeSessionId: 's1', chatScope: 'session', asking: false, askError: null,
    detail: { segments: [], notes: null, messages: [
      { id: 'u1', role: 'user', created_at: 't', content: 'Что решили по бюджету и срокам?' },
      { id: 'a1', role: 'assistant', created_at: 't', citations: [
        c('s2', 'P2', 65, 'Бюджет фиксируем на уровне десяти миллионов, без резерва.'),
        c('s3', 'P3', 80, 'Резерв обсудим отдельно, после квартала.'),
        c('s5', 'P5', 190, 'Дедлайн переносим на две недели.'),
        c('s9', 'P9', 12, 'В прошлой лекции говорили о рисках.', { session_id: 's2', session_title: 'Лекция 2' }),
      ], content: [
        '## Итог', '',
        '- **Бюджет** — 10 млн, без резерва [P2–P3]',
        '- **Срок** перенесён на *две недели* [P5]',
        '- Риски уже обсуждались в прошлой лекции [P9]', '',
        '| Вопрос | Решение |', '|---|---|', '| Бюджет | 10 млн [P2] |', '| Срок | +2 недели [P5] |', '',
        'Вне записи: `резерв` обычно 10–15%.',
      ].join('\n') },
      { id: 'u2', role: 'user', created_at: 't', content: 'А старый ответ?' },
      { id: 'a2', role: 'assistant', created_at: 't', content: 'Старый ответ без записанных меток [P1].',
        citations: [{ segment_id: 'x', start_ms: 5000, end_ms: 9000, text: 'old' }] },
    ] },
  } as never);
  const view = render(<AssistantPanel onCite={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Assistant' })).toHaveAttribute('data-engine', 'api'));
  fs.mkdirSync(path.dirname(out!), { recursive: true });
  fs.writeFileSync(out!, view.container.innerHTML);
});
