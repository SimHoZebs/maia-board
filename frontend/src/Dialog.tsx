import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function Dialog({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current!.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="dialog" aria-label={title} onCancel={event => { event.preventDefault(); onCancel(); }}>
    {children}
  </dialog>;
}
