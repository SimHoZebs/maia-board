// Thin barrel: focused panel modules live in sibling files. Existing
// `from "./ReadPanels"` imports keep working without behavior change.
export { InsightPanel, MoveAnalysis } from "../review/InsightPanel";
export {
  MoveNavBar,
  MovesPanel,
} from "../review/MovesPanel";
export type { MovesPanelProps, MoveNavBarProps } from "../review/MovesPanel";
export { SavedGames } from "../history/SavedGames";
export {
  ObjectiveBar,
  SkeletonList,
  SkeletonText,
} from "../review/ObjectiveBar";
