import { ArrowUpRight, BookOpen } from "lucide-react";
import { sideName } from "./domain";
import { countLabels, summarizeReview, type ReviewSide } from "./reviewSummary";
import type { Review } from "./useReview";
import "./review-overview.css";
import { QualityBadge, ReviewCharts } from "./ReviewCharts";
import { useLineOpenings } from "./openings";

export function ReviewSummary({
  review,
  ply,
  userSide,
  branch,
  onGraphView,
}: {
  review: Review;
  ply: number;
  userSide?: ReviewSide;
  branch: boolean;
  onGraphView: (ply: number) => void;
}) {
  const summary = summarizeReview(review.nodes, review.qualities, userSide);
  const complete = summary.reviewed === summary.total;
  // Opening identity of the viewed position: deepest named ancestor, so the
  // family persists after the line leaves book.
  const { opening } = useLineOpenings(review.timeline.moves, review.timeline.initialFen, ply);
  const sideLabel = (color: ReviewSide) =>
    `${sideName(color)} move quality${userSide === color ? " · You" : ""}`;
  return (
    <section
      className="review-overview"
      aria-label={branch ? "Explored line overview" : "Game overview"}
    >
      {!summary.total ? (
        <p className="empty-copy">
          Play or load some moves to see a move summary.
        </p>
      ) : (
        <>
          {opening && (
            <p className="opening-line" role="status">
              <BookOpen size={14} aria-hidden="true" />
              <strong>{opening.eco} · {opening.name}</strong>
              {!opening.isExact && <span className="opening-out"> · out of book</span>}
            </p>
          )}
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
                aria-label={sideLabel(side.color)}
              >
                <h3>
                  <span
                    className={`side-dot ${side.color}`}
                    aria-hidden="true"
                  />
                  {sideLabel(side.color)}
                </h3>
                <ul className="quality-counts" aria-label={`${sideName(side.color)} move counts`}>
                  {countLabels.map((label) => {
                    const count = side.counts[label];
                    const plural = label === "Inaccuracy" ? "Inaccuracies" : `${label}s`;
                    return (
                      <li key={label} className={count === 0 ? "zero" : undefined} title={`${count} ${plural}`}>
                        <QualityBadge
                          quality={{ label, accuracy: null, loss: null }}
                        />
                        <span aria-label={`${count} ${plural}`}>{count}</span>
                      </li>
                    );
                  })}
                </ul>
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
        </>
      )}
    </section>
  );
}

export function ReviewIssues({
  review,
  userSide,
  branch,
  onInspect,
}: {
  review: Review;
  userSide?: ReviewSide;
  branch: boolean;
  onInspect: (beforePly: number) => void;
}) {
  const summary = summarizeReview(review.nodes, review.qualities, userSide);
  const complete = summary.reviewed === summary.total;
  const sideLabel = (color: ReviewSide) =>
    `${sideName(color)}${userSide === color ? " · You" : ""}`;
  return (
    <section
      className="review-overview"
      aria-label={branch ? "Explored line moves to review" : "Moves to review"}
    >
      {!summary.total ? (
        <p className="empty-copy">
          Play or load some moves to see moves to review.
        </p>
      ) : (
        <>
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
                ? "No inaccuracies, mistakes, blunders, or allowed mates found."
                : "Inaccuracies, mistakes, blunders, and allowed mates will appear here as moves are reviewed."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

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
  return (
    <>
      <ReviewSummary
        review={review}
        ply={ply}
        userSide={userSide}
        branch={branch}
        onGraphView={onGraphView}
      />
      <ReviewIssues
        review={review}
        userSide={userSide}
        branch={branch}
        onInspect={onInspect}
      />
    </>
  );
}
