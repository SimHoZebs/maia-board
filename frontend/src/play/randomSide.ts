import type { SideColor } from '../eval/api';
export type SideChoice = SideColor | 'random';
export function resolveSide(choice: SideChoice, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): SideColor {
  return choice === 'random' ? (random() & 1 ? 'black' : 'white') : choice;
}
