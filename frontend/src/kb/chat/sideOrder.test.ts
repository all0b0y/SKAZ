import { describe, expect, it } from 'vitest';
import { switchDir } from './sideOrder';

describe('switch direction (decision 25)', () => {
  const order = ['a', 'b', 'c'];
  it('+1 when the new row is below the old one, −1 above', () => {
    expect(switchDir(order, 'a', 'c')).toBe(1);
    expect(switchDir(order, 'c', 'a')).toBe(-1);
  });
  it('New chat sits above every chat; a chat not in the side list counts as below', () => {
    expect(switchDir(order, null, 'a')).toBe(1);
    expect(switchDir(order, 'b', null)).toBe(-1);
    expect(switchDir(order, 'c', 'elsewhere')).toBe(1);
    expect(switchDir(order, 'elsewhere', 'a')).toBe(-1);
  });
});
