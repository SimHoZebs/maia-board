import type { Square } from 'chess.js';
import type { SideColor, MoveRequest, MoveResponse } from '../eval/api';
import type { Analysis, BoardOrientationSetting, Insight, Mode, Settings, StoredGame } from '../shared/domain';
import type { OutboxOp } from '../history/serverGames';
import type { StockfishSettings } from '../eval/stockfishSettings';
import type { ArrowBasis, ArrowSettings, ArrowSettingsKey, ArrowStyle } from '../settings/arrowSettings';
import type { BadgeLoading } from '../review/ReviewCharts';

type Request = { id: number; mode: 'play'; payload: MoveRequest };
export type Draft = Pick<Settings, 'botElo' | 'model'> & { userColor: 'white' | 'black' | 'random' };
export type PlayDraft = Draft & Pick<Settings, 'temperature'>;
export type State = {
  mode: Mode; play: StoredGame; saved: StoredGame[];
  started: boolean; setup: PlayDraft | null; viewedPly: number | null; stockfish: StockfishSettings; feedback: boolean; playVerdict: boolean; badgeLoading: BadgeLoading; coordinatesOnSquares: boolean; boardOrientation: BoardOrientationSetting; bestLineWindow: number; arrows: ArrowSettings; arrowBasis: ArrowBasis;
  analysis: Analysis; analysisSettings: Draft; analysisLoaded: boolean; importing: boolean; analysisSourceId: string | null;
  inputs: { fen: string; pgn: string }; flipped: boolean; preview: string | null;
  promotion: { from: Square; to: Square } | null;
  insight: Insight | null; error: string; request: Request | null; revision: number;
};
export type Action =
  | { type: 'mode'; mode: Mode }
  | { type: 'setup'; draft?: Partial<PlayDraft> } | { type: 'cancel-setup' }
  | { type: 'stockfish-settings'; settings: Partial<StockfishSettings> }
  | { type: 'feedback'; enabled: boolean }
  | { type: 'play-verdict'; enabled: boolean }
  | { type: 'badge-loading'; loading: BadgeLoading }
  | { type: 'coordinates-on-squares'; enabled: boolean }
  | { type: 'board-orientation'; orientation: BoardOrientationSetting }
  | { type: 'best-line-window'; window: number }
  | { type: 'arrow-settings'; source: ArrowSettingsKey; style: Partial<ArrowStyle> }
  | { type: 'arrow-basis'; basis: ArrowBasis }
  | { type: 'arrow-settings-reset' }
  | { type: 'new'; id: string; createdAt: string; resolvedColor?: 'white' | 'black'; userElo?: number }
  | { type: 'analysis-settings'; settings: Partial<Draft> }
  | { type: 'takeback' } | { type: 'resign' } | { type: 'flip' }
  | { type: 'move'; from: Square; to: Square }
  | { type: 'explore'; uci: string }
  | { type: 'explore-line'; ucis: string[] }
  | { type: 'preview'; uci: string | null } | { type: 'original' }
  | { type: 'promote'; piece: string | null }
  | { type: 'inputs'; inputs: Partial<State['inputs']> }
  | { type: 'load' } | { type: 'unload' } | { type: 'url-line'; initialFen: string; moves: string[] } | { type: 'step'; delta: number } | { type: 'advance' } | { type: 'view'; ply: number | null }
  | { type: 'saved'; id: string } | { type: 'review'; id?: string } | { type: 'delete'; id: string }
  | { type: 'reply'; request: Request; response: MoveResponse }
  | { type: 'failure'; request: Request; error: unknown }
  | { type: 'retry' }
  | { type: 'sync'; saved: StoredGame[]; currentId: string | null; total: number | null; pending: OutboxOp[] };
export type AnalysisSnapshot = { initialFen: string; moves: string[]; index: number; perspective: SideColor; ownGame: boolean; gameId?: string };
