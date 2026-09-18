// Thin barrel: focused panel modules live in sibling files. Existing
// `from "./ReadPanels"` imports keep working without behavior change.
export { InsightPanel, MoveAnalysis } from "./InsightPanel";
export {
  MoveNavBar,
  MovesPanel,
} from "./MovesPanel";
export type { MovesPanelProps, MoveNavBarProps } from "./MovesPanel";
export { SavedGames } from "./SavedGames";
export {
  ObjectiveBar,
  SkeletonList,
  SkeletonText,
} from "./ObjectiveBar";
