import { useLayoutEffect, useRef } from 'react';
import { ChessBishop, ChessKnight, ChessQueen, ChessRook } from 'lucide-react';
import { Button } from './components';

const PROMOTION_CHOICES = [
  { piece: 'q', name: 'Queen', Icon: ChessQueen },
  { piece: 'r', name: 'Rook', Icon: ChessRook },
  { piece: 'b', name: 'Bishop', Icon: ChessBishop },
  { piece: 'n', name: 'Knight', Icon: ChessKnight },
] as const;

export function PromotionDialog({ open, onChoose }: { open: boolean; onChoose: (piece: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (open && !dialog.current!.open) dialog.current!.showModal();
    if (!open && dialog.current!.open) dialog.current!.close();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, [open]);
  return <dialog className="promotion-dialog" id="promotion-dialog" aria-labelledby="promotion-title" ref={dialog} onCancel={event => { event.preventDefault(); onChoose(null); }}>
    <form method="dialog"><p className="eyebrow">Promotion</p><h2 id="promotion-title">Choose a piece</h2><div className="promotion-options">
      {PROMOTION_CHOICES.map(({ piece, name, Icon }) => <Button key={piece} data-promotion={piece} aria-label={name} title={name} onClick={() => onChoose(piece)}><Icon size={28} aria-hidden="true" className="promotion-icon" /><span>{name}</span></Button>)}
    </div></form>
  </dialog>;
}
