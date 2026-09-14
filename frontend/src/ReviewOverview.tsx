import { ArrowUpRight } from "lucide-react";
import { sideName } from "./domain";
import { issueLabels, summarizeReview, type ReviewSide } from "./reviewSummary";
import type { Review } from "./useReview";
import "./review-overview.css";
import { QualityBadge, ReviewCharts } from "./ReviewCharts";

export function ReviewOverview({
  review,
  ply,
  userSide,
  branch,
  onInspect,
  onGraphView,
}: {
  review: Review;
  ply: number;
  userSide?: ReviewSide;
  branch: boolean;
  onInspect: (beforePly: number) => void;
  onGraphView: (ply: number) => void;
}) {
  const summary = summarizeReview(review.nodes, review.qualities, userSide);
  const complete = summary.reviewed === summary.total;
  const sideLabel = (color: ReviewSide) =>
    `${sideName(color)}${userSide === color ? " · You" : ""}`;
  return (
    <section
      className="review-overview"
      aria-label={branch ? "Explored line overview" : "Game overview"}
    >
      {!summary.total ? (
        <p className="empty-copy">
          Play or load some moves to see an accuracy summary.
        </p>
      ) : (
        <>
          <ReviewCharts
            review={review}
            ply={ply}
            sans={review.nodes
              .slice(1)
              .map(node => node.san)}
            onView={onGraphView}
            side={userSide}
          />
          <div className="accuracy-summary">
            {summary.sides.map((side) => (
              <section
                key={side.color}
                className={`accuracy-card${userSide === side.color ? " own-side" : ""}`}
                aria-label={`${sideName(side.color)} accuracy`}
              >
                <h3>
                  <span
                    className={`side-dot ${side.color}`}
                    aria-hidden="true"
                  />
                  {sideLabel(side.color)}
                </h3>
                <strong className="accuracy-value">
                  {side.accuracy === null
                    ? "—"
                    : `${side.accuracy.toFixed(1)}%`}
                </strong>
                <span className="accuracy-caption">
                  {side.reviewed < side.total ? "Partial accuracy" : "Accuracy"}
                </span>
                <dl className="quality-counts">
                  {issueLabels.map((label) => (
                    <div key={label}>
                      <dt>
                        <QualityBadge
                          quality={{ label, accuracy: null, loss: null }}
                        />
                        {label === "Inaccuracy" ? "Inaccuracies" : label === "Miss" ? "Misses" : `${label}s`}
                      </dt>
                      <dd>{side.issues[label]}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {!complete && (
            <p className="overview-partial" role="status">
              {summary.reviewed
                ? "Summary covers reviewed moves only."
                : "No moves reviewed yet."}{" "}
              Use Analyze{branch ? "" : " for the entire game"} to complete the
              summary.
            </p>
          )}
          <div className="overview-issues-heading">
            <h3>Moves to review</h3>
            <span>{summary.issues.length}</span>
          </div>
          {summary.issues.length ? (
            <ol className="review-issues">
              {summary.issues.map((issue) => {
                const move = `${issue.moveNumber}${issue.color === "white" ? "." : "…"} ${issue.san}`;
                return (
                  <li key={issue.beforePly}>
                    <button
                      type="button"
                      className="review-issue"
                      aria-label={`Review ${move} · ${sideLabel(issue.color)} · ${issue.label}`}
                      onClick={() => onInspect(issue.beforePly)}
                    >
                      <span className="issue-move">
                        <strong>{move}</strong>
                        {!userSide && <small>{sideLabel(issue.color)}</small>}
                      </span>
                      <span className="issue-quality">
                        <QualityBadge
                          quality={{
                            label: issue.label,
                            accuracy: issue.accuracy,
                            loss: null,
                          }}
                        />
                        <span>{issue.label}</span>
                      </span>
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="empty-copy">
              {complete
                ? "No inaccuracies, mistakes, misses, blunders, or skulls found."
                : "Inaccuracies, mistakes, misses, blunders, and skulls will appear here as moves are reviewed."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
