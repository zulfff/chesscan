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

/// Cheap sanity gate. '?' means the classifier was unsure, which must never reach
/// the engine as a piece.
pub fn validate(b: &Board) -> Result<()> {
    let mut wk = 0;
    let mut bk = 0;
    for &c in b.iter() {
        match c {
            'K' => wk += 1,
            'k' => bk += 1,
            '?' => bail!("unknown piece on board; classifier needs recalibration"),
            _ => {}
        }
    }
    if wk != 1 || bk != 1 {
        bail!("expected exactly one king per side, got white={wk} black={bk}");
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
