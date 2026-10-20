# Board sounds

Verbatim copies of three files from the **standard** sound set of
[lichess-org/lila](https://github.com/lichess-org/lila)
(`public/sound/standard/` on `master`), licensed under **GNU Affero General
Public License v3.0** — same license as this repository (see root `LICENSE`).

| File in this directory | Lila source file    | Heard in maia-board as                   |
| ---------------------- | ------------------- | ---------------------------------------- |
| `move.mp3`             | `Move.mp3`          | quiet moves                              |
| `capture.mp3`          | `Capture.mp3`       | captures                                 |
| `notify.mp3`           | `GenericNotify.mp3` | checkmate and drawn/resigned-game chimes |

Check plays the move/capture knock (standard set resolves `check` to
silence); checkmate layers that knock with `notify.mp3`. Resolved in
`useBoardSounds.ts`.
