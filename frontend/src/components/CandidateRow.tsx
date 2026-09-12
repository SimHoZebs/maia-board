// One row of an engine candidate list. With `preview` the row is a button
// that previews the move on the board (hover/focus) and branches into it on
// click/tap; without it the row is static text. Both engines use the
// interactive form.
export function CandidateRow({ index, san, metric, isPlayed, preview }: {
  index: number; san: string; metric: string; isPlayed: boolean;
  preview?: { label: string; active: boolean; onPreview: () => void; onSelect: () => void };
}) {
  const inner = <>{isPlayed && <span className="visually-hidden">Played, </span>}<strong>{san}</strong><span className="metric">{metric}</span></>;
  return <li className={isPlayed ? 'played' : undefined}><span className="rank">{index + 1}</span>{preview ?
    <button type="button" className="candidate-reading" aria-label={preview.label} aria-pressed={preview.active} onMouseEnter={preview.onPreview} onFocus={preview.onPreview} onClick={preview.onSelect}>{inner}</button> :
    <span className="candidate-reading">{inner}</span>}</li>;
}
