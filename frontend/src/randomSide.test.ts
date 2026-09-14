import { expect, it } from 'vitest';
import { resolveSide } from './randomSide';
import { initialState, reducer } from './state';
it('resolves both random outcomes and leaves chosen sides alone', () => {
  expect(resolveSide('random', () => 0)).toBe('white');
  expect(resolveSide('random', () => 1)).toBe('black');
  expect(resolveSide('white', () => { throw Error('unused'); })).toBe('white');
});
it('stores the resolved side and preserves it through render-independent draft cancellation', () => {
  for (const userColor of ['white', 'black'] as const) {
    let state = reducer(initialState(), { type: 'setup', draft: { userColor: 'random' } });
    state = reducer(state, { type: 'new', id: 'random-game', createdAt: '2026-09-10', resolvedColor: userColor });
    expect(state.play.settings.userColor).toBe(userColor);
    state = reducer(state, { type: 'setup', draft: { userColor: 'random' } });
    state = reducer(state, { type: 'cancel-setup' });
    expect(state.play.settings.userColor).toBe(userColor);
    expect(state.play.settings.userColor).toBe(userColor);
  }
});
