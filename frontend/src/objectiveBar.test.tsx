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

it('shows white, draw, and black percentages from the WDL triple', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveBar, {
      turn: 'white', expected: 60, wdl: { white: 45, draw: 30, black: 25 }, orientation: 'white',
    }),
  );
  expect(html).toContain('W 45%');
  expect(html).toContain('D 30%');
  expect(html).toContain('B 25%');
  expect(html).toContain('White 45%');
  expect(html).toContain('Draw 30%');
  expect(html).toContain('Black 25%');
  expect(html).toContain('estimated White winning chance 60%');
  expect(html).toContain('balance-draw');
  expect(html).toContain('height:45%');
  expect(html).toContain('height:30%');
});

it('shows both sides without a draw segment when no WDL is available', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveBar, { turn: 'white', expected: 65, orientation: 'white' }),
  );
  expect(html).toContain('W 65%');
  expect(html).toContain('B 35%');
  expect(html).toContain('White 65%');
  expect(html).toContain('Black 35%');
  expect(html).not.toContain('balance-draw');
});
