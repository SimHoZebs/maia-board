import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';

export function Dialog({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // Native <dialog> focuses its first focusable child on showModal. Keep
    // that behavior so keyboard users land inside the modal immediately.
    return () => {
      if (dialog.open) dialog.close();
      // Return focus to the opener so Escape-to-close lands predictably.
      if (previous && document.contains(previous)) previous.focus();
      else (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
    };
  }, []);
  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    // Backdrop clicks target the <dialog> itself (content targets children),
    // so an exact-target check closes only outside the card.
    if (event.target === ref.current) onCancel();
  };
  return <dialog ref={ref} className="dialog" aria-label={title} onClick={onBackdropClick} onCancel={event => { event.preventDefault(); onCancel(); }}>
    <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onCancel}>✕</button>
    {children}
  </dialog>;
}
