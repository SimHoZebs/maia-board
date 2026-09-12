import { useEffect, useState } from "react";
import { QualityBadge } from "./ReviewCharts";
import "./eval-lab.css";

const FACES = [
  { label: "Best", glyph: "B", cls: "quality-best" },
  { label: "Good", glyph: "G", cls: "quality-good" },
  { label: "Great", glyph: "!", cls: "quality-great" },
  { label: "Inaccuracy", glyph: "?!", cls: "quality-inaccuracy" },
  { label: "Mistake", glyph: "?", cls: "quality-mistake" },
  { label: "Miss", glyph: "M", cls: "quality-miss" },
  { label: "Blunder", glyph: "??", cls: "quality-blunder" },
  { label: "Forced", glyph: "F", cls: "quality-forced" },
] as const;

const PIECES = ["♟", "♞", "♝", "♜", "♛", "♚"] as const;

// A genuinely pending evaluation, as the data layers produce it.
const PENDING = { label: "Unreviewed", accuracy: null, loss: null } as const;

function useCycle(length: number, ms: number) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % length),
      ms,
    );
    return () => window.clearInterval(id);
  }, [length, ms]);
  return index;
}

/** 1 — Mario Kart item roulette: hard-cuts through every real badge. */
function RouletteBadge({ ms = 110 }: { ms?: number }) {
  const i = useCycle(FACES.length, ms);
  const face = FACES[i];
  return (
    <span
      className={`quality ${face.cls} lab-roulette`}
      role="status"
      aria-label={`Evaluating… cycling ${face.label}`}
      title="Evaluating…"
    >
      {face.glyph}
    </span>
  );
}

/** 2 — Morph: slow crossfade with blur + scale, one badge becoming the next. */
function MorphBadge({ ms = 900 }: { ms?: number }) {
  const i = useCycle(FACES.length, ms);
  const face = FACES[i];
  return (
    <span
      key={i}
      className={`quality ${face.cls} lab-morph`}
      role="status"
      aria-label="Evaluating…"
      title="Evaluating…"
    >
      {face.glyph}
    </span>
  );
}

/** 3 — Slot reel: the default loading state, rendered by the real QualityBadge. */
function SlotBadge() {
  return <QualityBadge quality={{ ...PENDING }} reserveSpace loading="reel" />;
}

/** 4 — Shimmer chip: the selectable calm alternative, rendered by the real QualityBadge. */
function ShimmerBadge() {
  return <QualityBadge quality={{ ...PENDING }} reserveSpace loading="shimmer" />;
}

/** 5 — Escalation: ? → ?! → ??, dread building like the engine found something. */
function EscalationBadge({ ms = 500 }: { ms?: number }) {
  const steps = [FACES[4], FACES[3], FACES[6]] as const; // ?, ?!, ??
  const i = useCycle(steps.length, ms);
  const face = steps[i];
  return (
    <span
      className={`quality ${face.cls} lab-escalate`}
      role="status"
      aria-label="Evaluating…"
      title="Evaluating…"
    >
      {face.glyph}
    </span>
  );
}

/** 6 — Piece shuffle: cycles chess pieces instead of verdicts. */
function PieceBadge({ ms = 220 }: { ms?: number }) {
  const i = useCycle(PIECES.length, ms);
  return (
    <span
      className="quality lab-piece"
      role="status"
      aria-label="Evaluating…"
      title="Evaluating…"
    >
      {PIECES[i]}
    </span>
  );
}

/** 7 — Hue spin: single ? badge rainbow-cycling (conic/ hue-rotate). */
function HueBadge() {
  return (
    <span
      className="quality lab-hue"
      role="status"
      aria-label="Evaluating…"
      title="Evaluating…"
    >
      ?
    </span>
  );
}

/** 8 — Coin flip: 3D rotateY flip, glyph swaps mid-flip. */
function FlipBadge({ ms = 700 }: { ms?: number }) {
  const i = useCycle(FACES.length, ms);
  const face = FACES[i];
  return (
    <span className="lab-flip-scene" role="status" aria-label="Evaluating…">
      <span key={i} className={`quality ${face.cls} lab-flip`}>
        {face.glyph}
      </span>
    </span>
  );
}

function MoveContext({ badge }: { badge: React.ReactNode }) {
  return (
    <div className="lab-moves" aria-hidden="true">
      <span className="move-cell">
        <span>1.</span> e4 {badge}
      </span>
      <span className="move-cell">
        <span>1…</span> e5 {badge}
      </span>
      <span className="move-cell">
        <span>2.</span> Nf3 {badge}
      </span>
    </div>
  );
}

function Row({
  n,
  name,
  blurb,
  demo,
  verdict,
}: {
  n: string;
  name: string;
  blurb: string;
  demo: React.ReactNode;
  verdict: string;
}) {
  return (
    <section className="lab-row" aria-label={name}>
      <div className="lab-row-head">
        <span className="lab-num">{n}</span>
        <div>
          <h2>{name}</h2>
          <p>{blurb}</p>
        </div>
      </div>
      <div className="lab-demo">
        <div className="lab-demo-badges">{demo}</div>
        <MoveContext badge={demo} />
      </div>
      <p className="lab-verdict">{verdict}</p>
    </section>
  );
}

export function EvalLoadingLab() {
  return (
    <div className="app-shell lab-page">
      <header className="site-header">
        <span className="brand">maia board</span>
        <span className="lab-crumb">dev · eval-loading lab</span>
      </header>
      <main>
        <h1>Evaluation badge loading states</h1>
        <p className="lab-intro">
          Every row below is a live loading treatment for{" "}
          <code>QualityBadge</code> while Stockfish evaluations settle. Badges
          sit in real <code>.move-cell</code> rows so you can judge layout
          shift. Animations pause under{" "}
          <code>prefers-reduced-motion</code>.
        </p>
        <Row
          n="01"
          name="Mario Kart roulette"
          blurb="Hard-cuts through every real verdict glyph at 110ms — like the item box rolling before it lands."
          demo={<RouletteBadge />}
          verdict="Most fun, most on-brief. Risk: flashing colors can feel noisy across a full move list."
        />
        <Row
          n="02"
          name="Morph"
          blurb="Same roulette deck, but each glyph blurs + scales into the next every 900ms. Transformation, not flicker."
          demo={<MorphBadge />}
          verdict="Calmer cousin of 01. Reads as 'becoming the verdict' — nice middle ground."
        />
        <Row
          n="03"
          name="Slot reel ✓ default"
          blurb="The default loading state — this row renders the real QualityBadge. A vertical strip of every verdict spins behind the badge window (CSS only, no JS timer). Switch to Shimmer or Original blank under Settings → Experimental."
          demo={<SlotBadge />}
          verdict="Casino energy, zero JS cost. Constant motion may distract while reading lines."
        />
        <Row
          n="04"
          name="Shimmer chip (selectable alternative)"
          blurb="This row also renders the real QualityBadge — pick Shimmer under Settings → Experimental to use it. Neutral gray pulse matching the existing skeleton-list shimmer. No verdict spoilers."
          demo={<ShimmerBadge />}
          verdict="Production-safe and calm. Least fun, but the one that won't annoy on move 40."
        />
        <Row
          n="05"
          name="Escalation ? → ?! → ??"
          blurb="Dread builds: question mark grows teeth on a 500ms loop, as if the engine is finding something."
          demo={<EscalationBadge />}
          verdict="Storytelling in 3 frames. Funny when it lands on Good, spooky when it lands on ?? for real."
        />
        <Row
          n="06"
          name="Piece shuffle"
          blurb="Cycles ♟ ♞ ♝ ♜ ♛ ♚ — chess-native, verdict-neutral, no color flashing."
          demo={<PieceBadge />}
          verdict="Thematic and quiet. Doesn't preview verdict colors, so the real badge still pops."
        />
        <Row
          n="07"
          name="Hue spin"
          blurb="One ? badge hue-rotating through the rainbow. Single glyph, all vibes."
          demo={<HueBadge />}
          verdict="Maximum Mario Kart shimmer, minimum layout work. Could double as the 'analysis running' tint."
        />
        <Row
          n="08"
          name="Coin flip"
          blurb="3D flip on a 700ms timer; the glyph swaps exactly mid-flip when the badge is edge-on."
          demo={<FlipBadge />}
          verdict="Satisfying settle moment. Flipping a whole row of badges at once might be a lot — stagger in prod."
        />
      </main>
    </div>
  );
}
