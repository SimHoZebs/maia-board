// White-win-probability hero shared by the Maia and Stockfish estimates.
// The caller computes the rounded percent and caption so this component owns
// only the `section.estimate > div.win-hero` shape.
export function WinEstimate({ label, percent, caption }: { label: string; percent: number; caption: string }) {
  return <section className="estimate" aria-label={label}><div className="win-hero"><strong>{percent}%</strong><span>{caption}</span></div></section>;
}
