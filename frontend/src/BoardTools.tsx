export const ELO_OPTIONS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];
export const MAIA_ELO_MIN = ELO_OPTIONS[0];
export const MAIA_ELO_MAX = ELO_OPTIONS[ELO_OPTIONS.length - 1];
// Maia conditioning is only trained inside the offered range: a stored 400
// (real player Elo) still requests, displays, and caches as 800.
export function clampMaiaElo(elo: number): number {
  if (!Number.isFinite(elo)) return MAIA_ELO_MIN;
  return Math.min(MAIA_ELO_MAX, Math.max(MAIA_ELO_MIN, Math.round(elo)));
}
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
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API unavailable or denied: fall through to execCommand,
    // which remains the path for insecure LAN origins.
  }
  try {
    const field = document.createElement('textarea');
    try {
      field.value = text;
      document.body.appendChild(field);
      field.select();
      return document.execCommand('copy');
    } finally {
      field.remove();
    }
  } catch {
    return false;
  }
}
