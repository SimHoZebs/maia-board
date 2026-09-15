import { useCallback, useEffect, useRef, useState } from 'react';

// Transient UI flag that clears itself after `ms`: copy confirmations,
// "copied" checkmarks, and similar flashes. Owns its timer and unmount
// cleanup once so callers (SavedGames, AnalysisActions) share one shape
// instead of hand-rolled timer refs + cleanup effects.
export function useFlash<T>(ms = 2000): [T | null, (value: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const flash = useCallback((next: T) => {
    setValue(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setValue(null), ms);
  }, [ms]);
  return [value, flash];
}
