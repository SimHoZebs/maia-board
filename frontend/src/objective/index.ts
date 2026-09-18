// Objective source switch. Everything under ./maia and ./stockfish exposes
// identical names; the rest of the system imports from here and never
// branches on models. Flip the export below to change what "best" and
// "expected score" mean everywhere (grades, bar, graphs):
//   './maia'      — human-like expectations (extra inference lane)
//   './stockfish' — pure-engine behavior, no extra fetches
export * from './maia';
