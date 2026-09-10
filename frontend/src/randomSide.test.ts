import { expect, it } from 'vitest';
import { resolveSide } from './randomSide';
it('resolves both random outcomes and leaves chosen sides alone', () => {
  expect(resolveSide('random', () => 0)).toBe('white');
  expect(resolveSide('random', () => 1)).toBe('black');
  expect(resolveSide('white', () => { throw Error('unused'); })).toBe('white');
});
