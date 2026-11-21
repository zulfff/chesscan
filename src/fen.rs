//! Board grid -> FEN string.
//!
//! FEN wants rank 8 first, left to right. Our board is indexed (file, rank) with
//! rank 0 = rank 1, so the writer walks ranks descending. Castling rights and en
//! passant are inferred conservatively; engines tolerate a slightly loose FEN far
//! better than a missing or duplicated king, and we validate that up front.

use anyhow::{bail, Result};

/// 64 chars, index = rank * 8 + file, rank 0 = rank 1.
pub type Board = [char; 64];

pub fn empty_board() -> Board {
    ['.'; 64]
}

/// Infer castling rights from king/rook placement on their origin squares.
/// This cannot know history (a rook can return home), but a wrong extra right
/// costs an engine a few centipawns while a missing one can hide a legal reply.
fn castling(b: &Board) -> String {
    let mut s = String::new();
    let at = |f: u32, r: u32| b[(r * 8 + f) as usize];
    if at(4, 0) == 'K' {
        if at(7, 0) == 'R' {
            s.push('K');
        }
        if at(0, 0) == 'R' {
            s.push('Q');
        }
    }
    if at(4, 7) == 'k' {
        if at(7, 7) == 'r' {
            s.push('k');
        }
        if at(0, 7) == 'r' {
            s.push('q');
        }
    }
    if s.is_empty() {
        s.push('-');
    }
    s
}

pub fn to_fen(b: &Board, white_to_move: bool) -> Result<String> {
    let mut ranks = Vec::with_capacity(8);
    for rank in (0..8u32).rev() {
        let mut row = String::new();
        let mut run = 0;
        for file in 0..8u32 {
            let c = b[(rank * 8 + file) as usize];
            if c == '.' {
                run += 1;
            } else {
                if run > 0 {
                    row.push_str(&run.to_string());
                    run = 0;
                }
                row.push(c);
            }
        }
        if run > 0 {
            row.push_str(&run.to_string());
        }
        ranks.push(row);
    }
    validate(b)?;
    Ok(format!(
        "{} {} {} - 0 1",
        ranks.join("/"),
        if white_to_move { 'w' } else { 'b' },
        castling(b)
    ))
}

/// Cheap sanity gate. A FEN that cannot be a legal chess position must never
/// reach the engine: Stockfish will happily search 17 white pieces or two kings
/// standing next to each other, and the eval that comes back is fiction. The
/// classifier's `?` is already a refusal; this extends the same principle to
/// shapes that are individually plausible but collectively impossible.
///
/// `read::shape_ok` is the tolerant variant used during board *detection*: it
/// ignores unknown squares because a tooltip may cover one. This one is the
/// last gate before analysis, so it is strict.
pub fn validate(b: &Board) -> Result<()> {
    let mut wk = 0;
    let mut bk = 0;
    let mut wp = 0;
    let mut bp = 0;
    let mut wtot = 0;
    let mut btot = 0;
    let mut wking = None;
    let mut bking = None;
    for (i, &c) in b.iter().enumerate() {
        let rank = i / 8; // 0 = rank 1, 7 = rank 8
        match c {
            'K' => {
                wk += 1;
                wtot += 1;
                wking = Some(i);
            }
            'k' => {
                bk += 1;
                btot += 1;
                bking = Some(i);
            }
            'P' => {
                wp += 1;
                wtot += 1;
                if rank == 0 || rank == 7 {
                    bail!("white pawn on a back rank; board misread");
                }
            }
            'p' => {
                bp += 1;
                btot += 1;
                if rank == 0 || rank == 7 {
                    bail!("black pawn on a back rank; board misread");
                }
            }
            'Q' | 'R' | 'B' | 'N' => wtot += 1,
            'q' | 'r' | 'b' | 'n' => btot += 1,
            '?' => bail!("unknown piece on board; classifier needs recalibration"),
            _ => {}
        }
    }
    if wk != 1 || bk != 1 {
        bail!("expected exactly one king per side, got white={wk} black={bk}");
    }
    if wp > 8 || bp > 8 {
        bail!("more pawns than a side can have (white={wp}, black={bp}); board misread");
    }
    if wtot > 16 || btot > 16 {
        bail!("more pieces than a side can have (white={wtot}, black={btot}); board misread");
    }
    // Two kings can never occupy touching squares. This is the cheapest test
    // that catches a half-animation frame or a stale piece left on the board.
    if let (Some(a), Some(c)) = (wking, bking) {
        let dx = (a % 8).abs_diff(c % 8);
        let dy = (a / 8).abs_diff(c / 8);
        if dx <= 1 && dy <= 1 {
            bail!("kings are adjacent; board misread");
        }
    }
    Ok(())
}

/// Parse the "bestmove e2e4"-style UCI move into (from, to) board indices.
pub fn uci_to_squares(mv: &str) -> Option<(usize, usize)> {
    let b = mv.as_bytes();
    if b.len() < 4 {
        return None;
    }
    let file = |c: u8| -> Option<u32> { (b'a'..=b'h').contains(&c).then_some((c - b'a') as u32) };
    let rank = |c: u8| -> Option<u32> { (b'1'..=b'8').contains(&c).then_some((c - b'1') as u32) };
    let from = (rank(b[1])? * 8 + file(b[0])?) as usize;
    let to = (rank(b[3])? * 8 + file(b[2])?) as usize;
    Some((from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FEN placement string -> Board. Panics on a malformed fixture, which is
    /// what you want in a test.
    fn board(placement: &str) -> Board {
        let ranks: Vec<&str> = placement.split('/').collect();
        assert_eq!(ranks.len(), 8, "fixture needs 8 ranks");
        let mut b = empty_board();
        for (i, row) in ranks.iter().enumerate() {
            let rank = 7 - i;
            let mut file = 0usize;
            for ch in row.chars() {
                if let Some(n) = ch.to_digit(10) {
                    file += n as usize;
                } else {
                    assert!(file < 8, "fixture rank overflows");
                    b[rank * 8 + file] = ch;
                    file += 1;
                }
            }
            assert_eq!(file, 8, "fixture rank does not fill 8 files");
        }
        b
    }

    #[test]
    fn start_position_round_trips() {
        let b = board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
        assert!(validate(&b).is_ok());
        assert_eq!(
            to_fen(&b, true).unwrap(),
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        );
    }

    #[test]
    fn rejects_more_than_eight_pawns() {
        // Nine white pawns, kings legal. The old gate accepted this and handed
        // it to the engine as if it were a position.
        let b = board("4k3/8/8/8/8/P7/PPPPPPPP/4K3");
        let err = validate(&b).unwrap_err().to_string();
        assert!(err.contains("pawns"), "{err}");
    }

    #[test]
    fn rejects_more_than_sixteen_pieces() {
        let b = board("4k3/8/8/8/QQQQQQQQ/QQQQQQQQ/8/4K3");
        let err = validate(&b).unwrap_err().to_string();
        assert!(err.contains("pieces"), "{err}");
    }

    #[test]
    fn rejects_pawn_on_back_rank() {
        let b = board("4k3/8/8/8/8/8/8/P3K3");
        assert!(validate(&b).unwrap_err().to_string().contains("back rank"));
    }

    #[test]
    fn rejects_adjacent_kings() {
        let b = board("8/8/8/8/8/8/4k3/4K3");
        assert!(validate(&b).unwrap_err().to_string().contains("adjacent"));
    }

    #[test]
    fn rejects_unknown_squares() {
        let b = board("4k3/8/8/8/8/8/8/4K2?");
        assert!(validate(&b).unwrap_err().to_string().contains("unknown"));
    }

    #[test]
    fn promotion_material_is_legal() {
        // Three queens and eight pawns is still <=16 pieces: promotions are
        // legal and must not be rejected.
        let b = board("4k3/8/8/8/8/8/PPPPPPPP/Q2QK2Q");
        assert!(validate(&b).is_ok());
    }
}
