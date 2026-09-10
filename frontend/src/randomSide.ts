import type { MaiaColor } from './api';
export type SideChoice = MaiaColor | 'random';
export function resolveSide(choice: SideChoice, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): MaiaColor {
  return choice === 'random' ? (random() & 1 ? 'black' : 'white') : choice;
}
