// Thin barrel: focused panel modules live in sibling files. Existing
// `from "./ReadPanels"` imports keep working without behavior change.
export { InsightPanel, MoveAnalysis } from "./InsightPanel";
export {
  MoveNavBar,
  MovesPanel,
  PlayMovesPanel,
  AnalysisMovesPanel,
} from "./MovesPanel";
export type { MovesPanelProps, MoveNavBarProps } from "./MovesPanel";
export { SavedGames } from "./SavedGames";
export {
  StockfishBar,
  StockfishBody,
  SkeletonList,
  SkeletonText,
} from "./StockfishBar";
