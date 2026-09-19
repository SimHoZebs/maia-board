import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline } from './domain';
import { START_FEN } from './domain';
import { reviewNodes } from './reviewCoordinator';
import { initialState } from './state/index';
import { defaultStockfishSettings } from './stockfishSettings';
import { sfFixture } from './evaluationTestFixtures';
import { PlayVerdict } from './PlayVerdict';
import type { PlayFeedback } from './useReviewPipeline';
import type { State } from './state/index';

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
  const maia = {
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
    maiaResults: [maia, undefined],
    objectivePoints: [{ top: moveUci, expected: 60 }, { top: 'e7e5', expected: 50 }],
    engineGrades: [{ label: 'Top', accuracy: 100, loss: 0 }],
    settings: { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings },
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
    expect(html).toContain('The natural choice.');
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
});
