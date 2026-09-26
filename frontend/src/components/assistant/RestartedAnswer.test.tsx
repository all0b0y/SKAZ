import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CodexTask } from '../../api/codex';
import { MessageItem, RESTARTED_NOTE } from './AssistantShell';
import { CodexTaskCard } from './CodexTaskCard';

// Spec CODEX-NOTES-FIX §3: an interrupted answer is regenerated, not continued, and
// says so above the new text so a disappearing draft does not read as a bug.

const task = (restarted: boolean): CodexTask => ({
  id: 't', chat_id: 'c', session_ids: ['s1'], question: 'q', model: 'm', status: 'running',
  snapshot_id: 'x', answer: 'New answer', error: null, kind: 'chat', note_id: null,
  citations: [], activity: [], restarted,
});

const noop = () => {};
const list = (node: React.ReactNode) => render(<ul>{node}</ul>);

describe('restarted answer marker', () => {
  it('marks a saved answer that was generated again', () => {
    list(<MessageItem role="assistant" content="Ответ" restarted activeSessionId={null} onCite={noop} />);
    expect(screen.getByText(RESTARTED_NOTE)).toBeTruthy();
  });

  it('shows nothing extra on an ordinary answer or on the user side', () => {
    list(<>
      <MessageItem role="assistant" content="Ответ" activeSessionId={null} onCite={noop} />
      <MessageItem role="user" content="Question" restarted activeSessionId={null} onCite={noop} />
    </>);
    expect(screen.queryByText(RESTARTED_NOTE)).toBeNull();
  });

  it('marks the live task while it is being regenerated', () => {
    const { rerender } = list(<CodexTaskCard task={task(true)} activeSessionId={null} readOnly={false}
      onCite={noop} onStop={noop} onResume={noop} />);
    expect(screen.getByText(RESTARTED_NOTE)).toBeTruthy();
    rerender(<ul><CodexTaskCard task={task(false)} activeSessionId={null} readOnly={false}
      onCite={noop} onStop={noop} onResume={noop} /></ul>);
    expect(screen.queryByText(RESTARTED_NOTE)).toBeNull();
  });
});
