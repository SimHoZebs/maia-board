// One row of an engine candidate list. With `action` the row is a button
// that branches into the move on click/tap; without it the row is static
// text. Both engines use the interactive form.
export function CandidateRow({ index, san, metric, delta, isPlayed, action }: {
  index: number; san: string; metric: string; delta?: string; isPlayed: boolean;
  action?: { label: string; onSelect: () => void };
}) {
  const inner = <>{isPlayed && <span className="visually-hidden">Played, </span>}<strong>{san}</strong><span className="metrics"><span className="metric">{metric}</span>{delta !== undefined && <span className="delta">{delta}</span>}</span></>;
  return <li className={isPlayed ? 'played' : undefined}><span className="rank">{index + 1}</span>{action ?
    <button type="button" className="candidate-reading" aria-label={action.label} onClick={action.onSelect}>{inner}</button> :
    <span className="candidate-reading">{inner}</span>}</li>;
}
