# chesscan extension (chess.com)

Reads the board straight from the chess.com page and shows a Stockfish panel:
win probability, eval bar, the top three lines and the best-move arrow. No
screen capture, no calibration, no network — the engine runs locally as WASM.

For study and post-game review. Do not use it in rated online games: that is
cheating and chess.com will ban the account.

## Install (load unpacked)

```bash
cd extension
npm install
npm run build        # writes build/chrome and build/firefox
```

Chrome / Chromium / Edge:

1. `chrome://extensions`
2. enable **Developer mode**
3. **Load unpacked** → `extension/build/chrome`

Firefox:

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → `extension/build/firefox/manifest.json`

Then open any chess.com board (analysis, computer game, live game). The panel
appears in the top-right; drag it by the `⠿` handle.

## What it does

- Reads pieces from `wc-chess-board` (`.piece.<w|b><piece>.square-<file><rank>`),
  the last-move highlights, and the board's `flipped` class.
- Builds a FEN. Castling rights are inferred from king/rook home squares.
- Side to move comes from two independent signals: the piece diff between
  snapshots (a move changes at most three squares), and the last-move highlight
  (the destination square holds the mover). If both are ambiguous, use **flip**.
- Runs Stockfish 19 **lite, single-threaded** (1.8 MB WASM) at depth 18 with
  MultiPV 3. Depth is adjustable 12–22.
- Draws the best move as an arrow over the board, and the panel can be
  collapsed, closed (a pill reopens it), paused, or pointed at another depth.
- **play** selector: picks the move the way a player of a given rating would,
  instead of the way the engine would (see below).

Win probability is Lichess' fitted logistic curve on centipawns, so `+0.3`
reads as ~53% instead of "winning".

## Human-like moves

`src/humanize.js` turns a MultiPV search into a move choice, so the arrow (and
the highlighted line) suggests something a person would actually play rather
than the engine's first choice. Set **play** to `off`, `casual` (~850),
`club` (~1250), `solid` (~1750 with a fixed 60 cp ceiling and no slips),
`strong` (~1650), `expert` (~2000), `master` (~2300), or `max`.

`max` is the one mode that is not human-like: it skips the humanizer entirely,
runs MultiPV 1 at depth 22, and simply follows the engine. Use it when the
point is strength, not realism.

Three mechanisms, all driven by the same streamed search:

- **Temperature.** Candidates are weighted `exp(-Δ / T)` on win-probability
  loss, with `T` falling as rating rises. A 1250 genuinely considers a move
  0.3 pawns worse than the best one; a 2300 mostly does not.
- **First glance versus reflection.** The same MultiPV slot is re-emitted at
  every depth, so the module keeps each move's depth 2–6 evaluation and its
  final one. Good-at-a-glance and bad-on-reflection is a mistake a human makes,
  and it is played at a rating-scaled rate. The reverse — looked unsound,
  turns out best — is flagged as **find** and played sometimes.
- **Style.** A small bias toward promotions and forcing moves, scaled by
  aggression. It changes which equivalent move wins the roll, not whether a
  good move wins.

The pick is committed at depth 8 and then held for that position, so the arrow
does not twitch. It is then marked `.chosen` in the panel with a one-word label:
`natural`, `slip`, `find` or `forced`. Play mode runs the search at MultiPV 4
and cuts off at a centipawn ceiling (180 at 800, 60 at 2400) so the "human"
part comes from choosing between sound candidates, not from hanging pieces.
`solid` overrides that curve with a flat 60 cp ceiling and disables the mistake
path; `max` ignores the humanizer and reports `max` with no `.chosen` row.

This is a play-style model. It is not an anti-detection layer, and it is not
useful advice for rated games — see the note at the top.

## Architecture

| Context | Role |
| --- | --- |
| content script | reads the DOM, builds the FEN, draws the panel and arrow |
| background | routes jobs to the engine host, maps job ids back to tabs |
| offscreen document (Chrome) | hosts the engine `Worker` — MV3 service workers have no `Worker` constructor |
| background page (Firefox) | hosts the engine itself, since it is a real window |

Chrome and Firefox therefore need different `background` declarations, which is
why the build emits two folders. Engine replies go through the background with
`tabs.sendMessage`, because content scripts cannot be reached with
`runtime.sendMessage`.

The engine is created only when a board appears, and stopped when the tab is
hidden, the panel is closed, or the FEN stops changing. A heartbeat re-asks for
analysis if the service worker is torn down mid-search.

## Tests

```bash
npm test                          # unit + fixture e2e in real Chromium (headless)
node test/real-sites.mjs          # manual: real chess.com/analysis
node test/real-move.mjs           # manual: drag e2-e4 on the real board
node test/real-game.mjs 12        # manual: play 12 plies vs a chess.com bot
```

`npm test` runs the extension against DOM fixtures modelled on chess.com, on
both a permissive page and a page with `default-src 'self'`, using real
Stockfish. It checks the FEN, turn inference, move detection, manual flip,
flipped boards, engine lines, the arrow, play mode (four candidates, one picked
row, the label, and the return to plain best), and close/reopen.

The humanizer is also unit-tested separately, seeded so the checks are
deterministic: forced positions, a slip, a find, the centipawn ceiling, that a
master deviates from the engine best less often than a casual player, and that
`solid` never exceeds its 60 cp ceiling or reports a slip.
`node ../tools/humanize-check.mjs` prints the whole distribution per rating
against a few synthetic positions.

`test/real-game.mjs` goes further: it starts a guest game against a chess.com
bot, plays the moves by dragging on the board, and after every ply compares the
extension's FEN with an independent DOM read (and requires lines and an arrow).
It was run for 12 plies with every position matching.

Set `CHROMIUM=/path/to/chrome` if `chromium` is not in `PATH`.

## Limits

- chess.com only.
- Castling rights are inferred from piece placement; a king that moved and came
  back over-reports them. En passant is always `-`.
- Side to move is inferred, not read. After jumping around in the analysis move
  list, press **flip** if it is wrong.
- The lite engine is much weaker than full Stockfish, and runs without threads.
- Only the top frame is scanned, and only one board (the largest visible).
- Wayland/X11 are irrelevant here: everything is DOM, so it works on any OS
  Chrome or Firefox runs on.

## License

Project code is MIT (see `../LICENSE`). The bundled Stockfish build is GPLv3 and
keeps its own license; if you redistribute a build, comply with GPLv3.