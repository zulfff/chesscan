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

export function toFen(pieces, turn, { castling, fullmove = 1 } = {}) {
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
  return `${rows.join("/")} ${turn} ${rights || "-"} - 0 ${fullmove}`;
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