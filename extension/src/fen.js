// FEN assembly from a 64-square snapshot. Board indices are 0 = a1, 63 = h8,
// so index = rank * 8 + file with rank 0 being rank 1.

import { Chess } from "chess.js";

export const FILES = "abcdefgh";

export const indexOf = (file, rank) => rank * 8 + file;
export const fileOf = sq => sq % 8;
export const rankOf = sq => (sq / 8) | 0;

export function pieceLetter(piece) {
  return piece.color === "w" ? piece.type.toUpperCase() : piece.type;
}

/**
 * Castling rights are not visible on a board snapshot, so they are inferred the
 * same way chesscan's OCR path does it: king and rook still on their home
 * squares. A king that walked back home will over-report rights; that is the
 * cost of reading pixels instead of a PGN.
 */
export function inferCastling(pieces) {
  const at = (file, rank, color, type) => {
    const p = pieces[indexOf(file, rank)];
    return !!p && p.color === color && p.type === type;
  };
  let rights = "";
  if (at(4, 0, "w", "k")) {
    if (at(7, 0, "w", "r")) rights += "K";
    if (at(0, 0, "w", "r")) rights += "Q";
  }
  if (at(4, 7, "b", "k")) {
    if (at(7, 7, "b", "r")) rights += "k";
    if (at(0, 7, "b", "r")) rights += "q";
  }
  return rights;
}

/**
 * Update castling rights from a single move. `prev` and `curr` are the two
 * 64-square snapshots; the move between them is the only thing that can change
 * rights. A king that leaves home loses both rights, a rook that leaves its
 * home corner loses that side, and a rook captured on its home corner loses
 * that side. Rights are never granted back, so a king or rook that walks home
 * cannot resurrect them.
 */
export function updateCastling(rights, prev, curr) {
  if (!prev || !curr || prev.length !== 64 || curr.length !== 64) return rights;
  let out = rights || "";
  const drop = chars => {
    for (const c of chars) out = out.replace(c, "");
  };
  const rookHome = (color, sq) =>
    (color === "w" && (sq === 0 || sq === 7)) || (color === "b" && (sq === 56 || sq === 63));
  const dropRook = (color, sq) => {
    if (color === "w" && sq === 0) drop("Q");
    else if (color === "w" && sq === 7) drop("K");
    else if (color === "b" && sq === 56) drop("q");
    else if (color === "b" && sq === 63) drop("k");
  };

  for (let sq = 0; sq < 64; sq++) {
    const a = prev[sq];
    const b = curr[sq];
    if (!a && !b) continue;

    // A rook captured on its home square is gone even though the capturing
    // piece now occupies the square.
    if (a && b && a.color !== b.color && a.type === "r" && rookHome(a.color, sq)) {
      dropRook(a.color, sq);
    }

    // A piece that leaves a square. This is the move that actually costs the
    // right, even if the piece later comes back.
    if (a && !b) {
      if (a.type === "k") drop(a.color === "w" ? "KQ" : "kq");
      if (a.type === "r") dropRook(a.color, sq);
    }

    // A king arriving anywhere means it has moved; its rights are already
    // gone, but this also covers a king that was teleported by a jump.
    if (!a && b && b.type === "k") drop(b.color === "w" ? "KQ" : "kq");
  }
  return out;
}

function squareName(sq) {
  if (typeof sq === "string") {
    return /^[a-h][1-8]$/.test(sq) ? sq : "-";
  }
  if (!Number.isInteger(sq) || sq < 0 || sq > 63) return "-";
  return `${FILES[sq % 8]}${((sq / 8) | 0) + 1}`;
}

export function toFen(pieces, turn, { castling, enPassant = "-", fullmove = 1 } = {}) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pieces[indexOf(file, rank)];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      row += pieceLetter(piece);
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const rights = castling === undefined ? inferCastling(pieces) : castling;
  return `${rows.join("/")} ${turn} ${rights || "-"} ${squareName(enPassant)} 0 ${fullmove}`;
}

/**
 * Cheap sanity gates before handing a position to chess.js.
 *
 * chess.js checks kings, back-rank pawns and the FEN shape; it does not check
 * material counts or king adjacency. A half-rendered board can satisfy all of
 * its rules and still be a position that cannot exist, so the counts and the
 * adjacency test live here. Refusing a transient frame is cheap; analysing a
 * board that was never on screen is not.
 */
export function plausible(pieces) {
  if (!Array.isArray(pieces) || pieces.length !== 64) return false;
  let kings = 0;
  let wKing = -1;
  let bKing = -1;
  const pawns = { w: 0, b: 0 };
  const total = { w: 0, b: 0 };
  const extra = { w: 0, b: 0 };
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (let sq = 0; sq < 64; sq++) {
    const p = pieces[sq];
    if (!p) continue;
    if (p.color !== "w" && p.color !== "b") return false;
    if (p.type === "k") {
      kings++;
      if (p.color === "w") wKing = sq;
      else bKing = sq;
    }
    if (p.type === "p" && (rankOf(sq) === 0 || rankOf(sq) === 7)) return false;
    if (p.type === "p") pawns[p.color]++;
    total[p.color]++;
    if (count[p.color][p.type] !== undefined) count[p.color][p.type]++;
  }
  if (kings !== 2) return false;
  if (pawns.w > 8 || pawns.b > 8) return false;
  if (total.w > 16 || total.b > 16) return false;
  // A promoted piece costs a pawn. A third knight beside eight pawns is not a
  // position any game can reach; it is the same piece drawn on two squares
  // while an animation runs. This catches duplicates that chess.js accepts.
  for (const c of ["w", "b"]) {
    extra[c] =
      Math.max(0, count[c].r - 2) +
      Math.max(0, count[c].n - 2) +
      Math.max(0, count[c].b - 2) +
      Math.max(0, count[c].q - 1);
    if (pawns[c] + extra[c] > 8) return false;
  }
  // Kings can never stand on touching squares. This catches a mid-animation
  // frame or a stale piece that the DOM has not cleaned up yet.
  if (wKing >= 0 && bKing >= 0) {
    const dx = Math.abs((wKing % 8) - (bKing % 8));
    const dy = Math.abs(((wKing / 8) | 0) - ((bKing / 8) | 0));
    if (dx <= 1 && dy <= 1) return false;
  }
  return true;
}

/**
 * The FEN after `move`, with the en passant target kept when the move was a
 * double pawn push. chess.js omits the target unless a capture is legal right
 * now; the board still has one, and keeping it makes the FEN a faithful record
 * of the position rather than of one engine's shorthand.
 */
function afterFen(move) {
  const fields = move.after.split(" ");
  if (move.piece === "p" && Math.abs(Number(move.to[1]) - Number(move.from[1])) === 2) {
    fields[3] = `${move.from[0]}${(Number(move.from[1]) + Number(move.to[1])) / 2}`;
  }
  return fields.join(" ");
}

/**
 * Explain `pieces` as exactly one legal move from `fen`.
 *
 * Returns the resulting FEN, or null when no single legal move produces that
 * board (or when more than one does, which would be ambiguous). This is the
 * only test that cannot be fooled by a frame in flight: a piece drawn on two
 * squares, a capture whose victim has not been removed yet, or a board that
 * jumped two moves between ticks is not the result of any legal move, while a
 * board that moved a moment before the move list caught up is.
 *
 * `fen` must be the last *accepted* position, never the last DOM read, so one
 * transient frame cannot poison the comparison that follows it.
 */
export function successorOf(fen, pieces) {
  if (!fen || !Array.isArray(pieces) || pieces.length !== 64) return null;
  const want = toFen(pieces, "w").split(" ")[0];
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  let found = null;
  // chess.js fills `after` for every verbose move, so this never has to mutate
  // the game — important when the board ticks every 120 ms.
  for (const move of game.moves({ verbose: true })) {
    if (move.after.split(" ")[0] !== want) continue;
    // Two different moves producing the same board would make the turn a
    // guess. No legal pair does, but refusing is cheaper than being wrong.
    if (found) return null;
    found = move;
  }
  return found ? afterFen(found) : null;
}

/**
 * Every placement reachable from `fen` in exactly `n` plies, mapped to the FEN
 * that reaches it. Only one and two plies are enumerated: that is the gap a
 * fast game leaves between ticks, and it is small enough to be proof rather
 * than a guess. A placement reached by two different lines with different
 * rights or targets is stored as null, so it is refused like an ambiguity.
 */
export function reachableIn(fen, n) {
  if (!fen || (n !== 1 && n !== 2)) return null;
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  const out = new Map();
  const add = (placement, value) => {
    if (!out.has(placement)) out.set(placement, value);
    else if (out.get(placement) !== value) out.set(placement, null);
  };
  for (const first of game.moves({ verbose: true })) {
    if (n === 1) {
      add(first.after.split(" ")[0], afterFen(first));
      continue;
    }
    const mid = new Chess(first.after);
    for (const second of mid.moves({ verbose: true })) {
      add(second.after.split(" ")[0], afterFen(second));
    }
  }
  return out;
}

/**
 * True when the side that is *not* to move is in check. That cannot happen in a
 * legal game — it means the last "move" left the mover's own king attacked, or
 * the snapshot mixes two positions. `chess.js` validates the FEN shape, kings
 * and back-rank pawns, but not this, so ask it directly by flipping the side.
 * The en passant square is dropped: it belongs to the real side to move and
 * would be illegal after the flip.
 */
export function opponentInCheck(fen) {
  const parts = String(fen || "").split(" ");
  if (parts.length < 4 || (parts[1] !== "w" && parts[1] !== "b")) return false;
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  try {
    return new Chess(parts.join(" ")).isCheck();
  } catch {
    // Unparseable FENs are rejected by the caller's own construction check.
    return false;
  }
}

/**
 * Play a whole game of SAN moves from the standard start (or `startFen`) and
 * return the UCI move list for the post-game review. The page's move list is
 * the only record of a finished chess.com game and it speaks SAN; the review
 * server speaks UCI. Throws on the first move that is not legal in the line so
 * far: a truncated or mis-read list is an error, not half a game.
 */
export function sanLineToUci(sans, startFen = undefined) {
  const game = new Chess(startFen);
  const uci = [];
  for (const raw of sans) {
    const san = String(raw).replace(/[!?]+$/, "").trim();
    let move = null;
    try {
      move = game.move(san);
    } catch {
      move = null;
    }
    if (!move) throw new Error(`illegal SAN '${raw}' at ply ${uci.length}`);
    uci.push(move.from + move.to + (move.promotion || ""));
  }
  return { uci, over: gameOverOf(game) };
}

/** Why the game on `game` is over, or null while it goes on. */
function gameOverOf(game) {
  if (game.isCheckmate()) return game.turn() === "w" ? "checkmate_white" : "checkmate_black";
  if (game.isStalemate()) return "stalemate";
  if (game.isInsufficientMaterial()) return "insufficient_material";
  if (game.isThreefoldRepetition()) return "threefold";
  if (game.isDraw()) return "fifty_moves";
  return null;
}