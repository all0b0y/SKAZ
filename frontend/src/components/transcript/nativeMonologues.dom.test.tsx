/**
 * The transcript must stay navigable while it stops being one DOM node per
 * token. Baseline profile: a 60-minute recording rendered 33 478 spans and
 * re-rendered them every second (docs/BASELINE-PROFILE.md). Tokens of one
 * segment carry identical provenance, so they can share a node — but only if
 * source links, focus highlighting and speaker turns survive intact.
 */
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NativeMonologues } from './NativeMonologues';
import type { NativeSnapshot, NativeTranscriptToken } from '../../api/nativeLive';

// jsdom has no layout, so scrollIntoView is absent; the citation path calls it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const SAMPLE_RATE = 16_000;

function token(
  index: number, text: string, segmentId: string | null, speaker: number | null,
): NativeTranscriptToken {
  return {
    id: `c1:${index}`,
    connection_id: 'c1',
    segment_id: segmentId,
    text,
    speaker_number: speaker,
    start_sample: index * SAMPLE_RATE,
    end_sample: (index + 1) * SAMPLE_RATE,
  };
}

function snapshot(tokens: NativeTranscriptToken[]): NativeSnapshot {
  return {
    session_id: 's1',
    sample_rate: SAMPLE_RATE,
    saved_samples: tokens.length * SAMPLE_RATE,
    next_sequence: tokens.length,
    transcription: 'inactive',
    recording_mode: 'transcription',
    final_tokens: tokens,
    speakers: [],
    connections: [],
    gaps: [],
  };
}

describe('NativeMonologues DOM cost', () => {
  it('renders one node per segment, not per token', () => {
    // Three tokens of one segment, then two of another — as Soniox emits
    // word-level tokens that the backend groups into a segment.
    const view = render(
      <NativeMonologues
        snapshot={snapshot([
          token(0, 'Сегодня ', 'seg-a', 1),
          token(1, 'мы ', 'seg-a', 1),
          token(2, 'начинаем.', 'seg-a', 1),
          token(3, 'Второй ', 'seg-b', 1),
          token(4, 'сегмент.', 'seg-b', 1),
        ])}
        segments={[]}
        focusSegmentId={null}
      />,
    );
    const sources = view.container.querySelectorAll('[data-source-id]');
    expect(sources).toHaveLength(2);
    expect(Array.from(sources, (el) => el.textContent)).toEqual([
      'Сегодня мы начинаем.', 'Второй сегмент.',
    ]);
    // The full text is unchanged — no word is lost or reordered by grouping.
    expect(view.container.textContent).toContain('Сегодня мы начинаем.Второй сегмент.');
  });

  it('keeps every segment individually addressable for citations', () => {
    const view = render(
      <NativeMonologues
        snapshot={snapshot([
          token(0, 'Первый.', 'seg-a', 1),
          token(1, 'Второй.', 'seg-b', 1),
          token(2, 'Третий.', 'seg-c', 1),
        ])}
        segments={[]}
        focusSegmentId="seg-b"
      />,
    );
    const focused = view.container.querySelector('[data-source-id="seg-b"]');
    expect(focused).not.toBeNull();
    expect(focused!.className).toContain('segment--focused');
    // Only the cited segment is highlighted.
    expect(view.container.querySelectorAll('.segment--focused')).toHaveLength(1);
  });

  it('does not merge tokens across a speaker turn', () => {
    const view = render(
      <NativeMonologues
        snapshot={snapshot([
          token(0, 'Вопрос?', 'seg-a', 1),
          token(1, 'Ответ.', 'seg-b', 2),
        ])}
        segments={[]}
        focusSegmentId={null}
      />,
    );
    expect(view.container.querySelectorAll('.native-monologue')).toHaveLength(2);
    expect(Array.from(
      view.container.querySelectorAll('.native-monologue__speaker'),
      (el) => el.textContent,
    )).toEqual(['Спикер 1', 'Спикер 2']);
  });

  it('keeps the unsaved live tail addressable even though it has no segment', () => {
    // The replaceable tail has segment_id null: it must still render, and must
    // not be folded into the confirmed segment before it.
    const base = snapshot([token(0, 'Подтверждено.', 'seg-a', 1)]);
    const view = render(
      <NativeMonologues
        snapshot={{
          ...base,
          connections: [{
            id: 'c1', start_sample: SAMPLE_RATE, end_sample: null,
            final_sample: SAMPLE_RATE, processed_sample: 2 * SAMPLE_RATE,
            status: 'active',
            draft_json: JSON.stringify([
              { text: ' черновик', start_ms: 0, end_ms: 500, speaker: null },
            ]),
          }],
        }}
        segments={[]}
        focusSegmentId={null}
      />,
    );
    expect(view.container.textContent).toContain('Подтверждено.');
    expect(view.container.textContent).toContain('черновик');
    // The confirmed segment keeps its own source link, unpolluted by the tail.
    const confirmed = view.container.querySelector('[data-source-id="seg-a"]');
    expect(confirmed!.textContent).toBe('Подтверждено.');
  });
});
