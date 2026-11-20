// Side-to-move inference. A screen snapshot cannot carry the halfmove clock,
// so we use two independent signals and let the user override.

/**
 * A move adds a piece to its destination. Captures change the occupant's
 * colour; promotions change its type. Castling adds two pieces of one colour.
 * Anything bigger than that is a navigation jump, not a move, and is ignored.
 */
export function turnFromDiff(prev, curr) {
  if (!prev || !curr || prev.length !== 64) return null;
  const movers = [];
  let losses = 0;
  for (let sq = 0; sq < 64; sq++) {
    const a = prev[sq];
    const b = curr[sq];
    if (!a && b) movers.push(b);
    else if (a && !b) losses++;
    else if (a && b && (a.color !== b.color || a.type !== b.type)) movers.push(b);
  }
  if (movers.length === 0 || movers.length > 3 || losses > 2) return null;
  const colors = new Set(movers.map(p => p.color));
  if (colors.size !== 1) return null;
  return movers[0].color === "w" ? "b" : "w";
}

/**
 * The highlighted last move marks two squares. The destination is the one that
 * holds a piece, and that piece belongs to the side that just moved.
 */
export function turnFromLastMove(pieces, lastMove) {
  if (!lastMove || lastMove.length === 0) return null;
  const occupied = lastMove.filter(sq => sq >= 0 && sq < 64 && pieces[sq]);
  if (occupied.length === 0) return null;
  const colors = new Set(occupied.map(sq => pieces[sq].color));
  if (colors.size !== 1) return null;
  return occupied[0] ? (pieces[occupied[0]].color === "w" ? "b" : "w") : null;
}