// chess.com board reader.
//
// Two layouts have shipped over the years: piece elements carry square classes
// (square-52 = file 5, rank 2) or percentage transforms. Both are handled; the
// class form is the one current builds use.

const PIECE_CLASS = /^([wb])([pnbrqk])$/;
const SQUARE_CLASS = /^square-([1-8])([1-8])$/;

function squareFromClasses(el) {
  for (const cls of el.classList) {
    const m = SQUARE_CLASS.exec(cls);
    if (m) return (Number(m[2]) - 1) * 8 + (Number(m[1]) - 1);
  }
  return null;
}

export function readChesscom() {
  const boards = Array.from(
    document.querySelectorAll("wc-chess-board, chess-board"),
  );
  let picked = null;
  let bestArea = 0;

  for (const el of boards) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      picked = { el, rect };
    }
  }
  if (!picked) return null;

  const { el, rect } = picked;
  const flipped = el.classList.contains("flipped");
  const pieces = new Array(64).fill(null);

  for (const pieceEl of el.querySelectorAll(".piece")) {
    let color = null;
    let type = null;
    for (const cls of pieceEl.classList) {
      const m = PIECE_CLASS.exec(cls);
      if (m) {
        color = m[1];
        type = m[2];
        break;
      }
    }
    if (!color || !type) continue;

    let sq = squareFromClasses(pieceEl);
    if (sq === null) {
      const t = pieceEl.style.transform || "";
      const m = /translate\(\s*(-?[\d.]+)%[,\s]+(-?[\d.]+)%/.exec(t);
      if (m) {
        const col = Math.round(parseFloat(m[1]) / 100);
        const row = Math.round(parseFloat(m[2]) / 100);
        const file = flipped ? 7 - col : col;
        const rank = flipped ? row : 7 - row;
        if (file >= 0 && file < 8 && rank >= 0 && rank < 8) sq = rank * 8 + file;
      }
    }
    if (sq === null) continue;
    pieces[sq] = { color, type };
  }

  const lastMove = [];
  for (const hl of el.querySelectorAll(".highlight")) {
    const sq = squareFromClasses(hl);
    if (sq !== null) lastMove.push(sq);
  }

  return { site: "chesscom", pieces, lastMove, flipped, rect, boardEl: el, wrap: el };
}