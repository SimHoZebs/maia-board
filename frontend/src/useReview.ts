import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { buildTimeline, type TimelineRow } from './domain';
import type { MaiaModel, MoveResponse } from './api';
import type { State } from './state';
import { ReviewCoordinator, reviewKey, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { maiaRarity, reviewMove, type Evaluation, type Quality } from './reviewMetrics';

export type RecordStatus = { state: 'checking' | 'fresh' | 'none' };

// Per-position Maia identity: which Elo/model a displayed Maia result was
// computed under. Maia's own moves request the pinned game identity;
// everything else requests the adjustable analysis identity.
export type MaiaIdentity = { eloMaia: number; model: MaiaModel };
export function maiaIdentityOf(settings: { eloMaia: number; model: MaiaModel }): MaiaIdentity {
  return { eloMaia: settings.eloMaia, model: settings.model };
}
export function sameMaiaIdentity(a: MaiaIdentity, b: MaiaIdentity): boolean {
  return a.eloMaia === b.eloMaia && a.model === b.model;
}

// Pure side classification, tested without React: in an own-game main line,
// positions where the side to move is not the user's are Maia's moves and stay
// pinned to the game Elo. Terminals are never Maia positions (no Maia row
// exists for them) so the rating stays adjustable there. Everything else
// (non-own lines, branches) is adjustable. Reads turn/terminality off the
// canonical timeline row — never a replay.
export function isMaiaPosition(row: Pick<TimelineRow, 'turn' | 'terminal'>, userColor: 'white' | 'black', ownGame: boolean): boolean {
  if (!ownGame) return false;
  if (row.terminal !== null) return false;
  return row.turn !== userColor;
}

// One ply's verdict inputs. Verdicts are pure functions of (before/after
// evals, board, move), so a ply reuses its verdict exactly when the eval refs
// and pending state still match — regardless of coordinator version bumps
// from unrelated settles, line extensions/truncations, or settings changes
// (all of which surface as changed refs or fresh lookups). Output equality
// with a from-scratch recompute holds by construction: same function, same
// inputs. Fens always come from the current nodes (never cached), so only
// verdict objects are shared across runs.
type ReviewPlyVerdict = {
  before: Evaluation | undefined;
  after: Evaluation | undefined;
  needsPending: boolean;
  quality: Quality | undefined;
};

export type ReviewQualitiesMemo = {
  verdicts: (ReviewPlyVerdict | undefined)[];
  qualities: (Quality | undefined)[];
};

// Test observability only: counts reviewMove calls inside
// computeReviewQualities.
export type ReviewQualitiesStats = { reviews: number };

export function computeReviewQualities(args: {
  line: { moves: string[] };
  nodes: ReviewNode[];
  evaluations: (Evaluation | undefined)[];
  settingsForNode: (node: ReviewNode) => ReviewSettings;
  pending: Set<string>;
  prev: ReviewQualitiesMemo | null;
  stats?: ReviewQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: ReviewQualitiesMemo } {
  const { line, nodes, evaluations, settingsForNode, pending, prev, stats } = args;
  // Sentinel for plies whose queued evaluations have not settled. Same
  // contract as before: the coordinator's pending set decides what may still
  // arrive, so there is no per-source condition to fall behind.
  const awaitingEval: Quality = { label: 'Unreviewed', accuracy: null, loss: null };
  const verdicts: (ReviewPlyVerdict | undefined)[] = [];
  const qualities: (Quality | undefined)[] = [];
  let allReused = !!prev && prev.qualities.length === line.moves.length;
  line.moves.forEach((move, index) => {
    const before = evaluations[index];
    const after = evaluations[index + 1];
    const needsPending = (!before || !after) &&
      (pending.has(reviewKey('sf', nodes[index], settingsForNode(nodes[index]))) ||
        pending.has(reviewKey('sf', nodes[index + 1], settingsForNode(nodes[index + 1]))));
    const prevVerdict = prev?.verdicts[index];
    if (prevVerdict && prevVerdict.before === before && prevVerdict.after === after && prevVerdict.needsPending === needsPending) {
      verdicts.push(prevVerdict);
      qualities.push(prevVerdict.quality);
      return;
    }
    allReused = false;
    let quality: Quality | undefined;
    if (!before || !after) {
      quality = needsPending ? awaitingEval : undefined;
    } else {
      stats && stats.reviews++;
      quality = reviewMove(before, after, new Chess(nodes[index].fen), move);
    }
    verdicts.push({ before, after, needsPending, quality });
    qualities.push(quality);
  });
  const memo: ReviewQualitiesMemo = {
    verdicts,
    qualities: allReused && prev ? prev.qualities : qualities,
  };
  return { qualities: memo.qualities, memo };
}

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  // Mounted only inside AnalysisWorkspace: no play tree exists above this
  // hook, so cross-mode guards are gone. `active` now means only "a line is
  // loaded" (the importer form mounts with nothing to evaluate yet).
  const active = state.analysisLoaded;
  // Unsubscribed while no line is loaded (see subscribeNone): settles must
  // not re-render the importer. Index-independent memos below still read the
  // cache synchronously during render, so nothing displayed goes stale;
  // resubscribing on load re-reads the snapshot.
  useSyncExternalStore(active ? coordinator.subscribe : subscribeNone, coordinator.snapshot, coordinator.snapshot);
  // Line identity without replaying: only the normalized start and the merged
  // move list feed the key and the node timeline below. The full position
  // used to come along for the ride (two extra history walks per render);
  // nothing reads it, so it is no longer built here.
  const lineMoves = state.analysis.branchFromPly === null ? state.analysis.moves : [...state.analysis.moves.slice(0, state.analysis.branchFromPly), ...state.analysis.branchMoves];
  const line = { initialFen: new Chess(state.analysis.initialFen).fen(), moves: lineMoves };
  const lineKey = JSON.stringify([line.initialFen, line.moves]);
  // Canonical timeline, built once per line: the single progressive walk all
  // per-ply derivations read from.
  const timeline = useMemo(() => buildTimeline(line.initialFen, line.moves), [lineKey]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model, state.stockfish]);
  const settings: ReviewSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const maiaKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model]);
  const maiaIdentity: MaiaIdentity = useMemo(() => maiaIdentityOf(state.analysisSettings), [maiaKey]);
  const currentPly = state.analysis.index;
  const mainLine = state.analysis.branchFromPly === null;
  // Own-game pinning: Maia's moves stay at the game Elo/model while the
  // user's moves follow the adjustable analysis rating. Non-own lines (pasted
  // PGN/FEN) and explored branches stay fully adjustable.
  const ownGame = state.analysis.ownGame && mainLine;
  const gameForLine = ownGame
    ? (state.analysisSourceId
      ? (state.saved.find(game => game.id === state.analysisSourceId)
        ?? (state.play.id === state.analysisSourceId ? state.play : null))
      : state.play)
    : null;
  const pinnedKey = gameForLine ? JSON.stringify([gameForLine.settings.eloMaia, gameForLine.settings.eloUser, gameForLine.settings.model, gameForLine.settings.userColor]) : '';
  const pinnedSettings: ReviewSettings | null = useMemo(() => gameForLine
    ? { eloMaia: gameForLine.settings.eloMaia, eloUser: gameForLine.settings.eloUser, model: gameForLine.settings.model, stockfish: state.stockfish }
    : null, [pinnedKey, settingsKey]);
  const pinnedIdentity: MaiaIdentity | null = useMemo(() => gameForLine
    ? { eloMaia: gameForLine.settings.eloMaia, model: gameForLine.settings.model }
    : null, [pinnedKey]);
  const combinedKey = `${settingsKey}|${pinnedKey}|${ownGame ? 1 : 0}`;
  const userColorForLine = gameForLine?.settings.userColor;
  const isMaiaNode = (node: ReviewNode): boolean => {
    if (!ownGame || !userColorForLine) return false;
    // O(1) row lookup: ply === moves.length for nodes built from this line.
    const row = timeline.rows[node.moves.length];
    if (!row) return false;
    return isMaiaPosition(row, userColorForLine, ownGame);
  };
  const settingsForNode = useMemo(() => {
    if (!pinnedSettings) return (_node: ReviewNode) => settings;
    return (node: ReviewNode) => (isMaiaNode(node) ? pinnedSettings : settings);
  }, [settings, pinnedSettings, pinnedKey, ownGame, userColorForLine, timeline]);
  // Displayed move: the board shows the position after move x (and before move
  // y), so the analysis panel covers x — the move leading into the viewed
  // position — not y. Focus is that move's before-position; -1 at the start
  // (no move yet).
  const focusPly = currentPly - 1;
  // Nodes keep the ReviewNode shape the coordinator API requires (its key
  // function reads moves); the per-node slices are built here once from the
  // canonical timeline rows, never per render. Terminal flags below read the
  // same rows instead of walking the line a second time.
  const nodes = useMemo<(ReviewNode & { sanMoves: string[]; lastMove: [string, string] | undefined })[]>(() => {
    const sanMoves: string[] = [];
    return timeline.rows.map(row => {
      if (row.ply > 0) sanMoves.push(row.san);
      return { fen: row.fen, moves: line.moves.slice(0, row.ply), sanMoves: [...sanMoves], lastMove: row.lastMove, initialFen: timeline.initialFen };
    });
    // Deps mirror the pre-split memo: the branch merge allocates per render,
    // so depend on the source arrays, not the merged identity.
  }, [timeline, state.analysis.moves, state.analysis.branchMoves]);
  useEffect(() => { return () => coordinator.suspend(); }, [coordinator, active, lineKey, combinedKey, state.analysis.moves, state.analysis.branchMoves]);
  useEffect(() => {
    // Mobile background freezes timers and sockets while promises stay
    // pending: the running lane would never settle and progress would stall
    // with no failure to retry. On return, re-issue jobs that straddled the
    // freeze; healthy jobs are left alone. This never starts new work (see
    // resume), so restores still never infer.
    let hiddenAt = 0;
    const shown = (fallbackMs: number) => {
      const hiddenMs = fallbackMs || (hiddenAt ? Date.now() - hiddenAt : 0);
      hiddenAt = 0;
      coordinator.resume(hiddenMs);
    };
    const onHidden = () => { hiddenAt = Date.now(); };
    const onVisibility = () => {
      if (document.hidden) onHidden();
      else shown(0);
    };
    const onShown = () => shown(0);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', onShown);
    window.addEventListener('focus', onShown);
    window.addEventListener('online', onShown);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('pageshow', onShown);
      window.removeEventListener('focus', onShown);
      window.removeEventListener('online', onShown);
    };
  }, [coordinator]);
  useEffect(() => {
    coordinator.clearForeground();
    if (!active || nodes.length > 257) return;
    // Foreground covers the displayed move's before/after pair (Stockfish
    // needs both for the verdict) plus Maia for both sides: the panel judges
    // x (focus) while the arrows project y (current). Maia takes the first
    // two slots, so the focus goes first.
    const current = nodes[state.analysis.index];
    const focus = state.analysis.index > 0 ? nodes[state.analysis.index - 1] : null;
    const timer = setTimeout(() => coordinator.foregroundAt(focus ? [focus, current] : [current], settingsForNode, 2), 200);
    return () => { clearTimeout(timer); coordinator.clearForeground(); };
  }, [coordinator, active, nodes, state.analysis.index, combinedKey]);
  const progress = coordinator.progress;
  const primeKey = `${lineKey}|${combinedKey}`;
  const [primedKey, setPrimedKey] = useState<string | null>(null);
  useEffect(() => {
    // Prime from the server cache on every load: reads only, never inference,
    // so evicted/missing rows simply stay missing for the explicit,
    // user-gated batch. Records are not a gate here — play-time Stockfish and
    // Maia saves must be usable the moment the analysis opens. Own games prime
    // with split identities so Maia's pinned moves restore from play-time
    // saves at the game Elo.
    if (!active || !mainLine || primedKey === primeKey) return;
    const controller = new AbortController();
    void coordinator.primeLine(nodes, settingsForNode, controller.signal).then(
      () => setPrimedKey(primeKey),
      () => { /* Superseded by navigation or settings change; the next key reprimes. */ },
    );
    return () => controller.abort();
  }, [active, mainLine, primeKey, combinedKey, primedKey]);
  // Coverage is counted live from memory so LRU turnover after priming shows
  // up honestly instead of freezing the prime-time number.
  // Coverage and the derivations below all key on the coordinator's cache
  // version: any settled evaluation bumps it, so results refresh exactly
  // when cache contents change and reuse otherwise.
  const cacheVersion = coordinator.snapshot();
  // Terminal flags are per-line, not per-render: read off the canonical
  // timeline rows instead of walking the line a second time.
  const terminalByPly = useMemo(
    () => timeline.rows.map(row => row.terminal !== null),
    [timeline],
  );
  const coverage = useMemo(() => {
    if (!(active && mainLine && primedKey === primeKey)) return null;
    let covered = 0;
    for (let index = 0; index < nodes.length; index++) {
      const s = settingsForNode(nodes[index]);
      if (coordinator.result('sf', nodes[index], s) &&
        (terminalByPly[index] || coordinator.result('maia', nodes[index], s))) covered++;
    }
    return { total: nodes.length, covered };
  }, [active, mainLine, primedKey, primeKey, nodes, settingsForNode, terminalByPly, cacheVersion, coordinator]);
  // Completion derives from actual cached rows, not a parallel bookkeeping
  // record: while the prime is in flight the button shows Loading; once it
  // settles, full coverage reads fresh and anything else reads none (the
  // partial-coverage Analyze branch keys off coverage directly).
  const recordStatus: RecordStatus = useMemo(() => {
    if (!(active && mainLine)) return { state: 'none' };
    if (primedKey !== primeKey) return { state: 'checking' };
    return coverage && coverage.covered === coverage.total ? { state: 'fresh' } : { state: 'none' };
  }, [active, mainLine, primedKey, primeKey, coverage]);
  // Index-independent derivations, memoized (sharing cacheVersion above):
  // evaluations, qualities, and rarities depend only on the line, settings,
  // and cache contents — not on the viewed position. Without this every
  // arrow-key step recomputes the full quality loop (a legal-move generation
  // per ply), putting a game-length-scaled hitch between the keypress and
  // the board update.
  const evaluations = useMemo(
    () => nodes.map(node => coordinator.result('sf', node, settingsForNode(node))),
    [nodes, settingsForNode, cacheVersion, coordinator],
  );
  const maiaResults = useMemo(
    () => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))),
    [nodes, settingsForNode, cacheVersion, coordinator],
  );
  // Index-independent derivations, memoized (sharing cacheVersion above):
  // evaluations, qualities, and rarities depend only on the line, settings,
  // and cache contents — not on the viewed position. Without this every
  // arrow-key step recomputes the full quality loop (a legal-move generation
  // per ply), putting a game-length-scaled hitch between the keypress and
  // the board update. The qualities pass itself is incremental (see
  // computeReviewQualities): settles recompute only changed plies, so a batch
  // drain no longer replays the verdict loop per settle. The ref is read
  // during render but written post-commit, so StrictMode/concurrent
  // double-computes are merely less optimal, never wrong — reuse validity is
  // content-derived.
  const reviewQualitiesRef = useRef<ReviewQualitiesMemo | null>(null);
  const computedReviewQualities = useMemo(() => computeReviewQualities({
    line,
    nodes,
    evaluations,
    settingsForNode,
    pending: coordinator.sfPendingKeys(),
    prev: reviewQualitiesRef.current,
  }), [line.initialFen, line.moves, nodes, evaluations, settingsForNode, cacheVersion, coordinator]);
  useEffect(() => {
    reviewQualitiesRef.current = computedReviewQualities.memo;
  }, [computedReviewQualities]);
  const qualities = computedReviewQualities.qualities;
  // Additive difficulty axis: Maia probability ratio of the played move.
  // Own games anchor each ply to its responsible Elo: the user's moves to the
  // adjustable analysis rating, Maia's moves to the pinned game Elo.
  const rarities = useMemo(
    () => line.moves.map((move, index) => maiaRarity(maiaResults[index], move)),
    [line.moves, maiaResults],
  );
  const current = nodes[currentPly];
  const focusNode = focusPly >= 0 ? nodes[focusPly] : undefined;
  const focusIsMaia = !!focusNode && isMaiaNode(focusNode);
  // Requested identity per focus: Maia's own moves stay pinned to the game
  // Elo (settingsForNode resolves it); everything else follows the adjustable
  // analysis rating. The evaluation cache retains rows keyed by that identity.
  const focusSettings = focusNode ? settingsForNode(focusNode) : settings;
  const wantedIdentity = focusIsMaia ? pinnedIdentity! : maiaIdentity;
  const freshForFocus = focusNode && active ? coordinator.result('maia', focusNode, focusSettings) : undefined;
  // Stale-while-revalidating with a single display entry: while the requested
  // identity has no row yet, keep showing the last displayed row for THIS
  // node (never another node's, never another line's). Written post-commit
  // only — no render-phase setState, no per-ply map, no backfill.
  const displayRef = useRef<{ line: string; ply: number; identity: MaiaIdentity; result: MoveResponse } | null>(null);
  let maiaForFocus: MoveResponse | undefined;
  let displayedIdentity: MaiaIdentity;
  let maiaStale: boolean;
  if (!focusNode) {
    maiaForFocus = undefined; displayedIdentity = wantedIdentity; maiaStale = false;
  } else if (freshForFocus) {
    maiaForFocus = freshForFocus; displayedIdentity = wantedIdentity; maiaStale = false;
  } else {
    const kept = displayRef.current;
    if (kept && kept.line === lineKey && kept.ply === focusPly) {
      // Same node, requested row not settled yet (eviction, prime miss, or
      // refetch in flight): keep showing the last displayed row while the
      // requested one loads. Stale only when its identity differs from the
      // requested one.
      maiaForFocus = kept.result; displayedIdentity = kept.identity;
      maiaStale = !sameMaiaIdentity(kept.identity, wantedIdentity);
    } else {
      maiaForFocus = undefined; displayedIdentity = wantedIdentity; maiaStale = false;
    }
  }
  // New content clears the display entry, declared before the write so the
  // clear wins in a same-commit line change: stale associations from another
  // line must never leak into its headers, and the write below only stores
  // rows computed for the current line.
  useEffect(() => { displayRef.current = null; }, [lineKey]);
  useEffect(() => {
    if (focusPly >= 0 && maiaForFocus) displayRef.current = { line: lineKey, ply: focusPly, identity: displayedIdentity, result: maiaForFocus };
  }, [lineKey, focusPly, maiaForFocus, displayedIdentity]);
  const startBatchAtCurrent = () => {
    coordinator.startBatch(nodes, settingsForNode);
  };
  const currentSettings = current ? settingsForNode(current) : settings;
  // Forward Maia for the arrows (y's estimates from the viewed position).
  // Fresh identity only, no stale fallback: the foreground lane fetches it on
  // every navigation, so a missing row is briefly absent rather than wrong.
  // settingsForNode already pins Maia's own moves to the game Elo.
  const maiaCurrent = active && current ? coordinator.result('maia', current, currentSettings) : undefined;
  return { nodes, evaluations, qualities, rarities, coverage, current: evaluations[currentPly], focus: focusPly >= 0 ? evaluations[focusPly] : undefined, focusPly, maia: maiaForFocus, maiaCurrent,
    maiaElo: displayedIdentity.eloMaia, maiaModel: displayedIdentity.model,
    maiaWantedElo: focusIsMaia ? pinnedIdentity!.eloMaia : maiaIdentity.eloMaia,
    maiaWantedModel: focusIsMaia ? pinnedIdentity!.model : maiaIdentity.model,
    maiaStale, maiaLocked: focusIsMaia,
    gameElo: gameForLine?.settings.eloMaia,
    error: active && current ? coordinator.error('sf', current, currentSettings) || (focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : coordinator.error('maia', current, currentSettings)) : undefined,
    currentError: active && current ? coordinator.error('sf', current, currentSettings) : undefined,
    progress, recordStatus, start: startBatchAtCurrent, retry: () => coordinator.retry(),
    tooLong: nodes.length > 257 };
}
export type Review = ReturnType<typeof useReview>;
