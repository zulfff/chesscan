# chesscan-server

The analysis service behind the browser extension. It is a chess engine written
from scratch in Rust — board, move generator, evaluation, alpha-beta search, an
exact small-endgame solver and a "humanizer" that picks moves the way a player of
a given rating would. No UCI, no Stockfish, no borrowed evaluation function.

```
extension ──NDJSON over HTTP──> chesscan-server ──> best move + humanised pick
```

## Run

```bash
cd server
cargo build --release
PORT=8787 CHESSCAN_TOKEN=secret ./target/release/chesscan-server
```

| Environment variable        | Default | Meaning                                   |
| -------------------------- | ------- | ----------------------------------------- |
| `PORT`                     | `8787`  | Listen port                               |
| `CHESSCAN_TOKEN`           | unset   | If set, requests must send `Authorization: Bearer <token>` or `X-Chesscan-Token` |
| `CHESSCAN_MAX_JOBS`        | cores   | Concurrent searches; further requests get HTTP 429 |
| `CHESSCAN_SOLVER_PIECES`   | `6`     | Solve exactly only at or below this many pieces |
| `CHESSCAN_SOLVER_NODES`    | `5e6`   | Node budget for the exact solver          |
| `CHESSCAN_SOLVER_DEPTH`    | `16`    | Ply horizon for the exact solver          |

## Endpoints

### `GET /v1/health`

```json
{"ok":true,"version":"0.1.0","solver_pieces":6,"max_jobs":8}
```

### `POST /v1/analyze`

Request:

```json
{
  "fen": "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  "depth": 18,
  "multipv": 4,
  "time_ms": 4000,
  "play": {"mode": "club", "elo": 1250},
  "seed": "<position>:<ply>",
  "history": ["<earlier FEN>", "..."]
}
```

Response is newline-delimited JSON. One `info` event per completed depth, then a
`done` event:

```
{"type":"info","depth":6,"nodes":2049072,"lines":[...]}
{"type":"done","depth":8,"lines":[...],"pick":{...},"bestmove":"d2d4",
 "proven":false,"mate_in":null,"solver":{"attempted":false,"proven":false},
 "nodes":17169408,"time_ms":8000,"tt_hits":...,"tt_probes":...}
```

Each line carries `uci`, the principal variation `pv`, `score`
(`{"type":"cp","value":30}` or `{"type":"mate","value":2}`), the depth it was
searched at, the `shallow` score from the humaniser's "first glance" depth, and
a `win` probability. All scores are from the side-to-move's point of view.

`pick` is present only when `play` asks for it, and is the move the panel should
show: `uci`, `reason` (`temperature`, `mistake`, `brilliant`, `forced`),
`cp_loss`, `win`, `glance_win`, `think_ms`, `elo`.

## The humanizer

The engine reports the truth; the humanizer reports a plausible move. Three
mechanisms, all deterministic for a given `(fen, seed)`:

1. **Temperature.** Candidates are weighted by `exp(-win_loss / T)`, with `T`
   falling as the rating rises. A 1400 genuinely considers moves worth a fifth
   of a pawn of expectation; a 2300 does not.
2. **Depth disagreement.** The same candidate is evaluated at a shallow "glance"
   depth and at the final depth. Shallow-good/deep-bad is a slip; the reverse is
   a brilliancy, and brilliancies are played occasionally.
3. **Style.** A small bias toward forcing moves on the back rank, scaled by
   aggression.

A hard centipawn ceiling (rating-dependent, 60–180 cp) means the humanizer never
hangs a piece in the name of looking human. It chooses between good ideas, not
between good and bad ones.

`think_ms` is the amount of time a player of that rating would spend, given the
branching factor and how close the top candidates are. Autoplay uses it.

## The solver, and an honest word about "perfect"

Chess is not solved, so no engine can be perfect in the middlegame. What this
server can do is exact: for positions with `CHESSCAN_SOLVER_PIECES` or fewer
pieces, it searches the whole tree with no heuristic pruning and reports a
*proven* result — a forced mate with its distance, or the game-theoretic value
once every line is resolved. `done.proven` is true only in those cases. A mate
score is exact even when quiet alternatives were cut off; a non-mate score is
only called proven when the entire tree was resolved.

For everything else the server returns the best move its alpha-beta search can
prove within the time budget, together with the honest win probability from the
Lichess curve. That is what "best move to win" means in practice.

## Extension wiring

The extension's `src` selector has three values:

- `auto` — use the server when `/v1/health` answers, otherwise the bundled local
  engine.
- `server` — always use the server.
- `local` — always use the bundled local engine.

The gear button reveals the server URL and token fields. They are stored in
`chrome.storage.local`; the token is sent as a bearer token and never logged.

## Tests

```bash
cargo test
```

Perft is checked against the published node counts for the start position,
Kiwipete, positions 3–5, plus make/unmake round-trips, mate detection, repetition
draws and humanizer determinism.
