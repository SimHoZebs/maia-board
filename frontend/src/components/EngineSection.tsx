import type { ReactNode } from 'react';

// One engine column in the analysis insight panel (display or objective
// lane). Owns
// the section + heading + source-dot shape; the body (context line, estimates,
// candidate lists, empty copy) stays with the caller. The title can carry an
// inline control (the Maia rating owns its Elo here).
export function EngineSection({ label, titleId, dotClass, title, children }: { label: string; titleId?: string; dotClass: 'source-display' | 'source-objective'; title: ReactNode; children: ReactNode }) {
  return <section aria-label={label}>
    <h2 id={titleId}><span className={`source-dot ${dotClass}`} aria-hidden="true" /> {title}</h2>
    {children}
  </section>;
}
