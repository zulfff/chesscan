# chesscan

Live screen chess scanner in Rust: reads the board off your screen, turns it into
FEN, asks a UCI engine for the best lines, and paints a click-through HUD.

Built for study and post-game review. Do not point it at rated online games —
that is cheating, and every site will ban you for it.

## Browser extension (chess.com)

A separate, self-contained extension lives in `extension/`. It reads the board
straight from the chess.com DOM, runs Stockfish WASM locally and shows the same
eval/win% panel with a best-move arrow — no screen capture, no calibration.
A **play** selector can also pick the suggested move the way a player of a
given rating would, rather than the way the engine would.
See `extension/README.md`.

## Install on Fedora

```bash
sudo dnf install ./chesscan-0.4.0-1.x86_64.rpm
sudo dnf install stockfish      # engine; recommended by the package
```

Then launch **Chess Scanner** from the application menu, or run `chesscan-gui`.

Requires Fedora 40 or newer (built against glibc 2.39), X11 session recommended.

To rebuild the RPM after code changes:

```bash
./packaging/build-rpm.sh        # -> dist/chesscan-<version>-1.x86_64.rpm
```

## Desktop app

```bash
chesscan-gui
```

Left panel: detect, calibrate, engine settings, start/stop. Middle: live preview
of the board with the grid and the best-move arrow drawn over it. Right: top
lines with eval and win probability, the FEN, and whose turn it is.

- **Detect board** finds the board and saves the rect.
- **Calibrate** opens a dialog with one thumbnail per cluster and a piece
  dropdown. Do this once per theme, resolution and board size.
- **Start scanning** runs the loop. The window is a normal window, so it can be
  moved, minimised and alt-tabbed away from.

`chesscan-gui --auto` detects and starts immediately; `--pos X,Y` puts the window
at a fixed place; `--calibrate` jumps straight to the calibration dialog.

### Overlay mode (stream-alert style)

```bash
chesscan-gui --overlay --auto
```

A small borderless always-on-top panel instead of the full window: win
percentage, eval bar, the top three engine lines, a side-to-move flip, a
re-detect button and start/stop. Drag it by the `⠿ chesscan` handle; its
position is remembered across restarts. The application menu ships a
**Chess Scanner Overlay** entry that launches exactly this.

Detect and calibrate hide the app window for a moment before grabbing the
screen, so the scanner never reads its own window instead of the board.

Config lives in `$XDG_CONFIG_HOME/chesscan/config.json` (`CHESSCAN_CONFIG`
overrides it).

## CLI

The command line tool is still there and does the same work headlessly:

```bash
chesscan --auto --calibrate   # find board, learn theme
chesscan                      # scan + HUD
chesscan --detect             # print the board rect
chesscan --snapshot           # print the FEN and exit
```

## Build

```bash
sudo apt install libdbus-1-dev stockfish   # Debian/Ubuntu build deps
cargo build --release                      # live capture
cargo build --release --no-default-features # headless, --file only
```

Engine: any UCI binary works. `--engine /path/to/stockfish` or a mock (below).

## Test without a screen

```bash
cargo run --bin make_board -- /tmp/board.png            # synthetic start position
cargo run --bin make_board -- /tmp/board.png "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR"

./target/debug/chesscan --file /tmp/board.png --rect 0,0,640,640 \
  --calibrate --labels "R,.,n,P,q,b,p,B,N,K,k,r,Q"

./target/debug/chesscan --file /tmp/board.png --snapshot
./target/debug/chesscan --file /tmp/board.png --engine ./tools/mock_engine.py --no-hud
```

`tools/mock_engine.py` speaks UCI and returns fixed MultiPV lines, so the engine
loop, score parsing and win-probability math can be verified with no 100MB binary.
Overwrite the `--file` image while it runs to simulate moves being played.

`./tools/validate-pipeline.sh` runs the whole chain — detect, calibrate, FEN —
against synthetic shots at several board sizes and offsets, plus a boardless page
and a castled position. It exits non-zero if any stage is off, so it is the first
thing to run after touching detection or the descriptor.

To inspect one square's pixels instead of guessing:
`cargo run --example probe -- board.png e4 f6` prints its ink coverage and ink
colour, which tells a rescaling problem from a genuinely unknown piece.

## CLI quickstart

### 1. Let it find the board

```bash
./target/release/chesscan --detect
```

It looks for the 9x9 grid lines every chessboard has and prints the rect it
found. Nothing to measure by hand. Add `--file shot.png` to test against a
screenshot instead of the live screen.

### 2. Calibrate once per theme

```bash
./target/release/chesscan --auto --calibrate
```

`--auto` re-detects the board first. It clusters the 64 squares and asks you to
type a piece letter for each cluster, printing example square names (`[a1 h1]`)
so labelling is a look, not a guess. Expect ~13 clusters.

### 3. Run it

```bash
./target/release/chesscan
```

## Pipeline

```
capture  -> xcap / PNG
detect   -> edge profiles -> 9-line lattice with equal spacing
crop     -> board rect (detected, or manual --rect)
squares  -> 64 patches
classify -> local background subtraction + k-means prototypes
fen      -> board chars -> FEN (castling inferred from king/rook homes)
engine   -> Stockfish subprocess over UCI, MultiPV 3
hud      -> always-on-top panel with eval + win%
```

### Why grid lines, not square colours

Colour-parity detection (find the alternating light/dark pattern) is the obvious
first idea and it is fragile: it dies when a piece covers more than half a
square, and it dies again when the user switches board theme. The grid lines are
always there — 8 squares means 9 horizontal and 9 vertical lines, evenly spaced,
in every theme. So detection builds a row profile of horizontal edge energy and
a column profile of vertical edge energy, finds peaks, then searches for the
9-peak lattice whose spacing matches on both axes. This is the same route taken
by the OpenCV chessboard projects, and OpenCV's own docs note that
`findChessboardCorners` fails once pieces are on the board.

Nine evenly spaced lines are not proof of a chessboard, though: window chrome,
a spreadsheet, an icon grid. So each candidate lattice is cropped and read back,
and the first one that looks like a legal position wins. That read-back is also
what keeps a stale or clipped rect from surfacing as "classifier needs
recalibration" while the classifier is fine.

### Why prototypes instead of sprite templates

Templates are theme-locked and DPI-locked. Each square gets its background
estimated from its four corners — piece art is centred and never reaches them —
pixels far from that background become "ink", and the descriptor is an 8x8
ink-coverage grid plus the modal ink colour. Corners also absorb board tints, so
a highlighted last-move square does not turn into a fake piece. The outer 12% of
each square is ignored so grid-line bleed, in-square coordinate labels and a
one-pixel detection error cannot break prototype matching.

### Win probability

Lichess' fitted logistic curve on centipawn eval, so +0.3 reads as ~53% instead
of the fantasy "advantage" language engines use.

### Refusing beats guessing

A square the classifier is not sure about becomes `?`, and a board containing
`?` never reaches the engine. The same gate rejects positions that cannot exist:
more than eight pawns, more than sixteen pieces for one side, a pawn on a back
rank, or two kings on touching squares. The browser extension also refuses a
snapshot where the side that just moved is still in check. A skipped frame is
always cheaper than analysis of a board that was never on screen.

Engine output is guarded too: after a search is stopped, its trailing
`info`/`bestmove` lines are drained before the next position is sent, so a line
from the previous position cannot be reported as this one's best move.

## Known limits

- Piece prototypes are stamped with a descriptor revision. When a build changes
  the descriptor, the old vectors are dropped on load (with a note) and every
  square reads `?` until you calibrate again. That is deliberate: stale vectors
  do not fail loudly, they just misread pieces.
- Side to move is flipped on each detected board change, not read from the
  screen. Start it on the right side with `--white` / `--black`.
- En passant and castling history are not recoverable from pixels; castling is
  inferred from piece placement.
- Wayland capture is unreliable; use `--file` or X11.
- The HUD is opaque on purpose. Per-pixel-alpha arrows over the board need an
  ARGB compositor path (x11rb + tiny-skia); the HUD already draws the arrow in
  its mini diagram.
