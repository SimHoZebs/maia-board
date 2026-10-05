import type { ReactNode } from 'react';

// One engine column in the analysis insight panel (display or objective
// lane). Owns
// the section + heading + optional source-dot shape; the body (context line, estimates,
// candidate lists, empty copy) stays with the caller. The title can carry an
// inline control (the key-moves rating owns its Elo here). Sections without
// a lane source omit the dot.
export function EngineSection({ label, titleId, dotClass, title, children }: { label: string; titleId?: string; dotClass?: 'source-display' | 'source-objective'; title: ReactNode; children: ReactNode }) {
  return <section aria-label={label} className="engine-card">
    <h2 id={titleId}>{dotClass && <span className={`source-dot ${dotClass}`} aria-hidden="true" />} {title}</h2>
    {children}
  </section>;
}
