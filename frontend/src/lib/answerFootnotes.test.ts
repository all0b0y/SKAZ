import { describe, expect, it } from 'vitest';
import type { Citation } from '../api/types';
import { answerFootnotes, MARK_CLOSE, MARK_OPEN } from './answerFootnotes';

const cite = (id: string, labels: string[] = [], start = 0): Citation => ({
  segment_id: id, start_ms: start, end_ms: start + 1000, text: `text ${id}`, labels,
});
const mark = (n: number) => `${MARK_OPEN}${n}${MARK_CLOSE}`;

describe('answerFootnotes', () => {
  it('gives a range one footnote and a separate member its own', () => {
    const citations = ['P2', 'P3', 'P4', 'P5', 'P9'].map((l, i) => cite(`s${i}`, [l], i * 1000));
    const result = answerFootnotes('Budget was agreed [P2–P5, P9].', citations);
    expect(result.text).toBe(`Budget was agreed${mark(1)}${mark(2)}.`);
    expect(result.footnotes.map((f) => f.citations.map((c) => c.segment_id))).toEqual([['s0', 's1', 's2', 's3'], ['s4']]);
    expect(result.legacy).toEqual([]);
  });

  it('reuses the number of a source cited again and numbers in first-use order', () => {
    const citations = [cite('a', ['P1']), cite('b', ['P2'])];
    const result = answerFootnotes('One [P2]. Two [P1]. Again [P2].', citations);
    expect(result.text).toBe(`One${mark(1)}. Two${mark(2)}. Again${mark(1)}.`);
    expect(result.footnotes.map((f) => f.citations[0]!.segment_id)).toEqual(['b', 'a']);
  });

  it('continues the letter of the previous member and supports segment labels', () => {
    const citations = [cite('a', ['S1']), cite('b', ['S3'])];
    expect(answerFootnotes('X [S1, 3].', citations).footnotes).toHaveLength(2);
  });

  it('never guesses for answers saved without label records: marks are removed, sources become a list', () => {
    const citations = [cite('a'), cite('b')];
    const result = answerFootnotes('Old answer [P1] and more [P2, P3].', citations);
    expect(result.text).toBe('Old answer and more.');
    expect(result.footnotes).toEqual([]);
    expect(result.legacy).toEqual(citations);
  });

  it('drops a label with no recorded source instead of borrowing a neighbour', () => {
    const result = answerFootnotes('Known [P1], unknown [P7].', [cite('a', ['P1'])]);
    expect(result.text).toBe(`Known${mark(1)}, unknown.`);
    expect(result.footnotes).toHaveLength(1);
  });

  it('leaves prose brackets alone', () => {
    expect(answerFootnotes('See [2024] and [Fig 2] [P1].', [cite('a', ['P1'])]).text)
      .toBe(`See [2024] and [Fig 2]${mark(1)}.`);
  });
});
