export function Rating({ value, onChange, id = 'elo-maia', label = 'Maia rating' }: { value: number; onChange: (value: number) => void; id?: string; label?: string }) {
  return <label className="field"><span>{label}</span><select id={id} value={value} onChange={event => onChange(Number(event.target.value))}>
    {[...new Set([800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, value])].sort((a, b) => a - b).map(elo => <option key={elo}>{elo}</option>)}
  </select></label>;
}
export function downloadPgn(pgn: string, filename: string) {
  const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
