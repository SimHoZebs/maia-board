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

it('pins one tag per side with the draw centered on its segment', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveBar, {
      turn: 'white', expected: 60, wdl: { white: 45, draw: 30, black: 25 }, orientation: 'white',
    }),
  );
  expect(html).toContain('balance-white-tag');
  expect(html).toContain('balance-draw-tag');
  expect(html).toContain('balance-black-tag');
  expect(html).toContain('>45%<');
  expect(html).toContain('>30%<');
  expect(html).toContain('>25%<');
  expect(html).toContain('White 45%');
  expect(html).toContain('Draw 30%');
  expect(html).toContain('Black 25%');
  expect(html).toContain('estimated White winning chance 60%');
  expect(html).toContain('balance-draw');
  expect(html).toContain('height:45%');
  expect(html).toContain('height:30%');
  // Draw tag centered on its segment: offset = white + draw/2 = 60%.
  expect(html).toContain('bottom:60%');
});

it('shows both sides without a draw segment when no WDL is available', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveBar, { turn: 'white', expected: 65, orientation: 'white' }),
  );
  expect(html).toContain('balance-white-tag');
  expect(html).toContain('balance-black-tag');
  expect(html).not.toContain('balance-draw-tag');
  expect(html).toContain('>65%<');
  expect(html).toContain('>35%<');
  expect(html).toContain('White 65%');
  expect(html).toContain('Black 35%');
  expect(html).not.toContain('balance-draw');
});

it('keeps mate distance on the winning side and hides the zero side', () => {
  const html = renderToStaticMarkup(
    createElement(ObjectiveBar, {
      turn: 'white', expected: 65,
      mate: { type: 'mate', value: 5, winning_side: 'white' }, orientation: 'white',
    }),
  );
  expect(html).toContain('balance-white-tag');
  expect(html).not.toContain('balance-black-tag');
  expect(html).toContain('>+M5<');
});
