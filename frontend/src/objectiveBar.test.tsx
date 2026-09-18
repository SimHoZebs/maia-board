import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ObjectiveBar } from './ObjectiveBar';

it('reads the bar from objective White winning chances, never centipawns', () => {
  const white = renderToStaticMarkup(
    createElement(ObjectiveBar, { turn: 'white', expected: 65, orientation: 'white' }),
  );
  expect(white).toContain('aria-label="Position evaluation"');
  expect(white).toContain('65%');
  expect(white).toContain('estimated White winning chance 65%');
  expect(white).not.toMatch(/[+-]\d+\.\d\d/);
  const black = renderToStaticMarkup(
    createElement(ObjectiveBar, { turn: 'black', expected: 65, orientation: 'white' }),
  );
  expect(black).toContain('35%');
});

it('pins forced mates and terminal outcomes over the expectation', () => {
  const mate = renderToStaticMarkup(
    createElement(ObjectiveBar, {
      turn: 'white', expected: 65,
      mate: { type: 'mate', value: 5, winning_side: 'white' }, orientation: 'white',
    }),
  );
  expect(mate).toContain('+M5');
  expect(mate).toContain('estimated White winning chance 100%');
  const mated = renderToStaticMarkup(
    createElement(ObjectiveBar, {
      turn: 'white', expected: 65,
      outcome: { kind: 'checkmate', winner: 'black' }, orientation: 'white',
    }),
  );
  expect(mated).toContain('Black wins');
});
