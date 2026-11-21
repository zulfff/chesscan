// FEN assembly from a 64-square snapshot. Board indices are 0 = a1, 63 = h8,
// so index = rank * 8 + file with rank 0 being rank 1.

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

/** Cheap sanity gates before handing a position to chess.js. */
export function plausible(pieces) {
  let kings = 0;
  let pawnsOnBackRank = false;
  for (let sq = 0; sq < 64; sq++) {
    const p = pieces[sq];
    if (!p) continue;
    if (p.type === "k") kings++;
    if (p.type === "p" && (rankOf(sq) === 0 || rankOf(sq) === 7)) pawnsOnBackRank = true;
  }
  return kings === 2 && !pawnsOnBackRank;
}