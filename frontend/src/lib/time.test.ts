import { describe, it, expect } from 'vitest';
import { formatTimecode } from './time';

describe('formatTimecode', () => {
  it('formats sub-hour times as mm:ss', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(5000)).toBe('00:05');
    expect(formatTimecode(65000)).toBe('01:05');
    expect(formatTimecode(600000)).toBe('10:00');
  });

  it('formats times of an hour or more as h:mm:ss', () => {
    expect(formatTimecode(3600000)).toBe('1:00:00');
    expect(formatTimecode(3665000)).toBe('1:01:05');
  });

  it('floors partial seconds and clamps negatives to zero', () => {
    expect(formatTimecode(5999)).toBe('00:05');
    expect(formatTimecode(-1000)).toBe('00:00');
  });
});
