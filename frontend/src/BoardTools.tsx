export const ELO_OPTIONS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];
export function eloOptions(value: number): number[] {
  return [...new Set([...ELO_OPTIONS, value])].sort((a, b) => a - b);
}
export function Rating({ value, onChange, id = 'elo-maia', label = 'Maia rating', disabled = false, inline = false }: { value: number; onChange: (value: number) => void; id?: string; label?: string; disabled?: boolean; inline?: boolean }) {
  const select = <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
    {eloOptions(value).map(elo => <option key={elo} value={elo}>{elo}</option>)}
  </select>;
  if (inline) return select;
  return <label className="field"><span>{label}</span>{select}</label>;
}
export function downloadPgn(pgn: string, filename: string) {
  const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
