# Board sounds

Verbatim copies of three files from the **standard** sound set of
[lichess-org/lila](https://github.com/lichess-org/lila)
(`public/sound/standard/` on `master`), which is free software licensed
under the **GNU Affero General Public License v3.0** — the same license
this repository carries (see the root `LICENSE`).

| File in this directory | Lila source file | Heard in maia-board as |
| --- | --- | --- |
| `move.mp3` | `Move.mp3` | quiet moves |
| `capture.mp3` | `Capture.mp3` | captures |
| `notify.mp3` | `GenericNotify.mp3` | checkmate and drawn/resigned-game chimes |

Notes on fidelity to lichess behavior (see `ui/site/src/sound.ts` in
lila: a checking move plays the move/capture knock plus the `check`
sound, and the standard set resolves `check` to silence):

- A checking move plays the same knock lichess would: `move.mp3` when
  quiet, `capture.mp3` when it takes (resolved in `useBoardSounds.ts`).
- Checkmate layers the underlying knock with `notify.mp3`, mirroring
  lichess playing the move knock plus the game-end jingle. The standard
  set resolves `victory`/`defeat`/`draw` to this same chime, so drawn
  and resigned games play it on its own.
