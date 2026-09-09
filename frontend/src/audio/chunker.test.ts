import { describe, it, expect } from 'vitest';
import { WindowChunker } from './chunker';

const ramp = (from: number, count: number): Float32Array => {
  const a = new Float32Array(count);
  for (let i = 0; i < count; i += 1) a[i] = from + i;
  return a;
};

const concat = (parts: Float32Array[]): Float32Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('WindowChunker', () => {
  it('emits exact-size windows and holds the remainder', () => {
    const c = new WindowChunker(4);
    expect(c.push(ramp(0, 2))).toEqual([]); // buffered 2
    const out = c.push(ramp(2, 4)); // buffered 6 -> one window of 4, hold 2
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
    expect(c.buffered).toBe(2);
  });

  it('emits multiple windows when a single push spans several', () => {
    const c = new WindowChunker(3);
    const out = c.push(ramp(0, 7)); // 7 -> windows [0,1,2],[3,4,5], hold [6]
    expect(out.map((w) => Array.from(w))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(c.buffered).toBe(1);
  });

  it('never loses or reorders samples across push and flush', () => {
    const c = new WindowChunker(5);
    const pushed: Float32Array[] = [];
    const emitted: Float32Array[] = [];
    let value = 0;
    for (const size of [1, 4, 9, 2, 7, 3]) {
      const frame = ramp(value, size);
      value += size;
      pushed.push(frame);
      emitted.push(...c.push(frame));
    }
    const tail = c.flush();
    if (tail) emitted.push(tail);
    expect(Array.from(concat(emitted))).toEqual(Array.from(concat(pushed)));
  });

  it('flush returns the shorter-than-window tail then empties', () => {
    const c = new WindowChunker(4);
    c.push(ramp(0, 6)); // one window, hold 2
    const tail = c.flush();
    expect(tail).not.toBeNull();
    expect(Array.from(tail!)).toEqual([4, 5]);
    expect(c.buffered).toBe(0);
    expect(c.flush()).toBeNull();
  });

  it('flush returns null when nothing is buffered', () => {
    const c = new WindowChunker(4);
    c.push(ramp(0, 8)); // exactly two windows, nothing held
    expect(c.buffered).toBe(0);
    expect(c.flush()).toBeNull();
  });

  it('treats an exact multiple as full windows with no tail', () => {
    const c = new WindowChunker(2);
    const out = c.push(ramp(0, 6));
    expect(out).toHaveLength(3);
    expect(c.flush()).toBeNull();
  });
});
