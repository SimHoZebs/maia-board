import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline } from '../shared/domain';
import { START_FEN } from '../shared/domain';
import { reviewNodes } from '../review/reviewCoordinator';
import { initialState } from '../state/index';
import { defaultStockfishSettings } from '../eval/stockfishSettings';
import { sfFixture } from '../eval/evaluationTestFixtures';
import { PlayVerdict } from './PlayVerdict';
import type { PlayFeedback } from '../review/useReviewPipeline';
import type { State } from '../state/index';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
});

function setup(moveUci = 'e2e4') {
  const timeline = buildTimeline(START_FEN, [moveUci]);
  const nodes = reviewNodes(timeline);
  const evaluations = nodes.map(node => sfFixture(node.fen));
  const bot = {
    move: moveUci,
    top_moves: [{ move: moveUci, prob: 0.5, wdl: [0.2, 0.3, 0.5] as [number, number, number] }],
    wdl: [0.2, 0.3, 0.5] as [number, number, number],
    model_used: '79m' as const,
    degraded: false,
  };
  const feedback: PlayFeedback = {
    active: true,
    qualities: [{ label: 'Best', accuracy: 100, loss: 0 }],
    timeline,
    nodes,
    evaluations,
    botResults: [bot, undefined],
    objectivePoints: [{ top: moveUci, expected: 60 }, { top: 'e7e5', expected: 50 }],
    engineGrades: [{ label: 'Top', accuracy: 100, loss: 0 }],
    objectiveBestLine: [],
    settings: { botElo: 1600, userElo: 1600, model: '79m', stockfish: defaultStockfishSettings },
  };
  const base = initialState();
  const state: State = {
    ...base,
    feedback: true,
    playVerdict: true,
    viewedPly: 1,
    bestLineWindow: 3,
    play: { ...base.play, moves: [moveUci], settings: { ...base.play.settings, userColor: 'white' } },
  };
  return { state, feedback };
}

describe('PlayVerdict', () => {
  it('renders the synthesis verdict for the viewed user move', () => {
    const { state, feedback } = setup();
    const html = renderToStaticMarkup(createElement(PlayVerdict, { state, feedback }));
    expect(html).toContain('A natural choice.');
    expect(html).toContain('move-verdict');
  });

  it('stays quiet when the verdict option is off', () => {
    const { state, feedback } = setup();
    const html = renderToStaticMarkup(createElement(PlayVerdict, { state: { ...state, playVerdict: false }, feedback }));
    expect(html).toBe('');
  });

  it('stays quiet when move evaluation is off', () => {
    const { state, feedback } = setup();
    const html = renderToStaticMarkup(
      createElement(PlayVerdict, { state: { ...state, feedback: false }, feedback: { ...feedback, active: false } }),
    );
    expect(html).toBe('');
  });

  it('shows a loading skeleton while the pair is missing', () => {
    const { state, feedback } = setup();
    const html = renderToStaticMarkup(
      createElement(PlayVerdict, {
        state,
        feedback: {
          ...feedback,
          qualities: [{ label: 'Unreviewed', accuracy: null, loss: null }],
          evaluations: [undefined, undefined],
        },
      }),
    );
    expect(html).toContain('Loading move verdict');
  });

  it('suggests the grading-lane walk, never the Stockfish PV', () => {
    // Regression test for the Nh4 report: 12. Nh4 blundered, Stockfish's
    // rank-1 reply was 12... Nxc4 (itself a Maia mistake), and the verdict
    // quoted the Stockfish line. The suggestion must come from the
    // grading-lane walk instead, even when a Stockfish PV is present.
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'h7h6', 'e1g1', 'f8c5', 'c2c3', 'g8f6', 'd2d4', 'e5d4', 'c3d4', 'c5b6', 'c1e3', 'd7d6', 'd4d5', 'c6a5', 'd1d3', 'e8g8', 'b1d2', 'f8e8', 'f3h4'];
    const timeline = buildTimeline(START_FEN, moves);
    const nodes = reviewNodes(timeline);
    const evaluations = nodes.map(node => sfFixture(node.fen));
    // Stockfish distractor: the old source would read bishop+pawn for knight.
    evaluations[23] = { ...evaluations[23], best_move: 'a5c4', score: { type: 'cp' as const, value: -238 },
      lines: [{ move: 'a5c4', score: { type: 'cp' as const, value: -238 }, depth: 14, pv: ['a5c4', 'd2c4', 'e8e4'] }] };
    // Nh4 sits outside the bot's top moves: unlisted.
    const unlistedBot = {
      move: 'e3b6',
      top_moves: [{ move: 'e3b6', prob: 0.3, wdl: [0.2, 0.3, 0.5] as [number, number, number] }],
      wdl: [0.2, 0.3, 0.5] as [number, number, number],
      model_used: '79m' as const,
      degraded: false,
    };
    const feedback: PlayFeedback = {
      active: true,
      qualities: [...Array(22).fill(undefined), { label: 'Blunder', accuracy: 20, loss: 30 }],
      timeline,
      nodes,
      evaluations,
      botResults: [...Array(22).fill(undefined), unlistedBot, undefined],
      objectivePoints: [...Array(22).fill(undefined), { top: 'e3b6', expected: 50 }, { top: 'f6e4', expected: 80 }],
      engineGrades: [],
      // Grading-lane walk: Black's 2400 reply Nxe4 takes the e-pawn.
      objectiveBestLine: ['f6e4'],
      settings: { botElo: 1600, userElo: 1600, model: '79m', stockfish: defaultStockfishSettings },
    };
    const base = initialState();
    const state: State = {
      ...base,
      feedback: true,
      playVerdict: true,
      viewedPly: 23,
      bestLineWindow: 3,
      play: { ...base.play, moves, settings: { ...base.play.settings, userColor: 'white' } },
    };
    const html = renderToStaticMarkup(createElement(PlayVerdict, { state, feedback }));
    expect(html).toContain('An unlisted blunder.');
    expect(html).toContain('This line wins a pawn for Black.');
    expect(html).not.toContain('loses a bishop');
  });
});
