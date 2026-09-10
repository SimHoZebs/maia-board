import { useLayoutEffect, useRef } from 'react';

export function PromotionDialog({ open, onChoose }: { open: boolean; onChoose: (piece: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (open && !dialog.current!.open) dialog.current!.showModal();
    if (!open && dialog.current!.open) dialog.current!.close();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, [open]);
  return <dialog className="promotion-dialog" id="promotion-dialog" aria-labelledby="promotion-title" ref={dialog} onCancel={event => { event.preventDefault(); onChoose(null); }}>
    <form method="dialog"><p className="eyebrow">Promotion</p><h2 id="promotion-title">Choose a piece</h2><div className="promotion-options">
      {Object.entries({ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }).map(([piece, name]) => <button type="button" key={piece} data-promotion={piece} onClick={() => onChoose(piece)}>{name}</button>)}
    </div></form>
  </dialog>;
}
