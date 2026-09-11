import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Icon-only button (board chrome, move navigation). Owns `type="button"` and
// the paired `aria-label`/`title`; visual sizing stays with the container
// stylesheets (`.board-actions button`, `.nav-buttons button`,
// `.header-action`), which the browser specs assert on. Callers pass the icon
// element (lucide, size 18) as children. Hard-coded attributes come last so
// callers cannot accidentally override them.
export function IconButton({ id, label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button {...rest} id={id} type="button" aria-label={label} title={label} className={className}>{children}</button>;
}
