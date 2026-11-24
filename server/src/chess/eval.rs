//! Evaluation.
//!
//! Tapered material plus piece-square tables, with a handful of structural
//! terms. This is deliberately *not* a neural net: every term here is readable
//! and tunable, which is the whole reason the server is ours and not a
//! downloaded binary. The tables are written from the white side with rank 1
//! first, so black reads the mirrored index (`sq ^ 56`).

use super::board::{tables, Board};
use super::types::*;

const MG_VALUE: [i32; 6] = [82, 337, 365, 477, 1025, 0];
const EG_VALUE: [i32; 6] = [94, 281, 297, 512, 936, 0];

// Phase weights for the taper; 24 is the starting total.
const PHASE_WEIGHT: [i32; 6] = [0, 1, 1, 2, 4, 0];
const MAX_PHASE: i32 = 24;

/// Rough opening material value of a piece type, used by the search for
/// capture pruning. Deliberately coarse: it only has to be within a safe
/// margin of the real values.
pub fn victim_value(pt: usize) -> i32 {
    MG_VALUE[pt]
}

const MG_PAWN: [i32; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 0, 0, 0, //
    2, 4, 6, 8, 8, 6, 4, 2, //
    6, 8, 12, 16, 16, 12, 8, 6, //
    12, 14, 18, 24, 24, 18, 14, 12, //
    20, 22, 26, 32, 32, 26, 22, 20, //
    40, 40, 40, 40, 40, 40, 40, 40, //
    0, 0, 0, 0, 0, 0, 0, 0,
];

const MG_KNIGHT: [i32; 64] = [
    -10, -8, -6, -4, -4, -6, -8, -10, //
    -8, 0, 2, 4, 4, 2, 0, -8, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -4, 4, 10, 14, 14, 10, 4, -4, //
    -4, 4, 10, 14, 14, 10, 4, -4, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -8, 0, 2, 4, 4, 2, 0, -8, //
    -10, -8, -6, -4, -4, -6, -8, -10,
];

const MG_BISHOP: [i32; 64] = [
    -6, -4, -2, -2, -2, -2, -4, -6, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -2, 4, 8, 8, 8, 8, 4, -2, //
    -2, 4, 8, 12, 12, 8, 4, -2, //
    -2, 4, 8, 12, 12, 8, 4, -2, //
    -2, 4, 8, 8, 8, 8, 4, -2, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -6, -4, -2, -2, -2, -2, -4, -6,
];

const MG_ROOK: [i32; 64] = [
    0, 0, 4, 8, 8, 4, 0, 0, //
    2, 4, 6, 8, 8, 6, 4, 2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    0, 0, 0, 4, 4, 0, 0, 0,
];

const MG_QUEEN: [i32; 64] = [
    -4, -2, -2, -1, -1, -2, -2, -4, //
    -2, 0, 0, 0, 0, 0, 0, -2, //
    -2, 0, 1, 1, 1, 1, 0, -2, //
    -1, 0, 1, 2, 2, 1, 0, -1, //
    -1, 0, 1, 2, 2, 1, 0, -1, //
    -2, 0, 1, 1, 1, 1, 0, -2, //
    -2, 0, 0, 0, 0, 0, 0, -2, //
    -4, -2, -2, -1, -1, -2, -2, -4,
];

const MG_KING: [i32; 64] = [
    -40, -30, -20, -10, -10, -20, -30, -40, //
    -30, -20, -10, 0, 0, -10, -20, -30, //
    -20, -10, 0, 10, 10, 0, -10, -20, //
    -10, 0, 10, 20, 20, 10, 0, -10, //
    -10, 0, 10, 20, 20, 10, 0, -10, //
    -20, -10, 0, 10, 10, 0, -10, -20, //
    -30, -20, -10, 0, 0, -10, -20, -30, //
    -50, -40, -30, -20, -20, -30, -40, -50,
];

const EG_PAWN: [i32; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, //
    40, 40, 40, 40, 40, 40, 40, 40, //
    20, 22, 26, 32, 32, 26, 22, 20, //
    12, 14, 18, 24, 24, 18, 14, 12, //
    6, 8, 12, 16, 16, 12, 8, 6, //
    2, 4, 6, 8, 8, 6, 4, 2, //
    0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 0, 0, 0,
];

const EG_KNIGHT: [i32; 64] = [
    -10, -8, -6, -4, -4, -6, -8, -10, //
    -8, 0, 2, 4, 4, 2, 0, -8, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -4, 4, 10, 14, 14, 10, 4, -4, //
    -4, 4, 10, 14, 14, 10, 4, -4, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -8, 0, 2, 4, 4, 2, 0, -8, //
    -10, -8, -6, -4, -4, -6, -8, -10,
];

const EG_BISHOP: [i32; 64] = [
    -6, -4, -2, -2, -2, -2, -4, -6, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -2, 4, 8, 8, 8, 8, 4, -2, //
    -2, 4, 8, 12, 12, 8, 4, -2, //
    -2, 4, 8, 12, 12, 8, 4, -2, //
    -2, 4, 8, 8, 8, 8, 4, -2, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -6, -4, -2, -2, -2, -2, -4, -6,
];

const EG_ROOK: [i32; 64] = [
    0, 0, 4, 8, 8, 4, 0, 0, //
    2, 4, 6, 8, 8, 6, 4, 2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    -4, -2, 0, 2, 2, 0, -2, -4, //
    0, 0, 0, 4, 4, 0, 0, 0,
];

const EG_QUEEN: [i32; 64] = [
    -4, -2, -2, -1, -1, -2, -2, -4, //
    -2, 0, 0, 0, 0, 0, 0, -2, //
    -2, 0, 1, 1, 1, 1, 0, -2, //
    -1, 0, 1, 2, 2, 1, 0, -1, //
    -1, 0, 1, 2, 2, 1, 0, -1, //
    -2, 0, 1, 1, 1, 1, 0, -2, //
    -2, 0, 0, 0, 0, 0, 0, -2, //
    -4, -2, -2, -1, -1, -2, -2, -4,
];

const EG_KING: [i32; 64] = [
    -50, -30, -20, -10, -10, -20, -30, -50, //
    -30, -10, 0, 10, 10, 0, -10, -30, //
    -20, 0, 20, 30, 30, 20, 0, -20, //
    -10, 10, 30, 40, 40, 30, 10, -10, //
    -10, 10, 30, 40, 40, 30, 10, -10, //
    -20, 0, 20, 30, 30, 20, 0, -20, //
    -30, -10, 0, 10, 10, 0, -10, -30, //
    -50, -30, -20, -10, -10, -20, -30, -50,
];

const PASSED_BONUS_MG: [i32; 8] = [0, 5, 10, 20, 35, 60, 100, 0];
const PASSED_BONUS_EG: [i32; 8] = [0, 10, 20, 35, 60, 100, 160, 0];

#[inline]
fn mirror(sq: u8) -> usize {
    (sq ^ 56) as usize
}

pub struct Eval {
    pub mg: i32,
    pub eg: i32,
    pub phase: i32,
}

impl Eval {
    pub fn score(&self) -> i32 {
        let phase = self.phase.clamp(0, MAX_PHASE);
        (self.mg * phase + self.eg * (MAX_PHASE - phase)) / MAX_PHASE
    }
}

fn pawn_terms(board: &Board, color: Color, sign: i32, mg: &mut i32, eg: &mut i32) {
    let them = color.opposite();
    let our_pawns = board.pieces[piece_index(color, PAWN)];
    let their_pawns = board.pieces[piece_index(them, PAWN)];
    let mut rest = our_pawns;
    while rest != 0 {
        let sq = pop_lsb(&mut rest);
        let file = file_of(sq);
        let rank = rank_of(sq);
        let rel_rank = if color == Color::White { rank } else { 7 - rank };

        // Doubled: another of ours on the same file.
        let file_bb = our_pawns & file_mask(file);
        if file_bb.count_ones() > 1 {
            *mg -= sign * 12;
            *eg -= sign * 24;
        }

        // Isolated: no friendly pawn on an adjacent file.
        let adj = adjacent_files(file) & our_pawns;
        if adj == 0 {
            *mg -= sign * 14;
            *eg -= sign * 18;
        }

        // Passed: no enemy pawn ahead on this file or either adjacent file.
        let ahead = if color == Color::White {
            !0u64 << (sq + 8)
        } else {
            (1u64 << sq) - 1
        };
        let zone = (file_mask(file) | adjacent_files(file)) & ahead;
        if their_pawns & zone == 0 {
            *mg += sign * PASSED_BONUS_MG[rel_rank as usize];
            *eg += sign * PASSED_BONUS_EG[rel_rank as usize];
        }
    }
}

#[inline]
fn file_mask(file: u8) -> u64 {
    0x0101_0101_0101_0101u64 << file
}

#[inline]
fn adjacent_files(file: u8) -> u64 {
    let mut m = 0u64;
    if file > 0 {
        m |= file_mask(file - 1);
    }
    if file < 7 {
        m |= file_mask(file + 1);
    }
    m
}

fn rook_terms(board: &Board, color: Color, sign: i32, mg: &mut i32, eg: &mut i32) {
    let pawns = board.pieces[piece_index(Color::White, PAWN)]
        | board.pieces[piece_index(Color::Black, PAWN)];
    let mut rest = board.pieces[piece_index(color, ROOK)];
    while rest != 0 {
        let sq = pop_lsb(&mut rest);
        let file_bb = file_mask(file_of(sq));
        if pawns & file_bb == 0 {
            *mg += sign * 22;
            *eg += sign * 10;
        } else if board.pieces[piece_index(color, PAWN)] & file_bb == 0 {
            *mg += sign * 10;
            *eg += sign * 5;
        }
    }
}

fn king_safety(board: &Board, color: Color, sign: i32, mg: &mut i32) {
    let ksq = board.king_square(color);
    let kfile = file_of(ksq);
    let krank = rank_of(ksq);
    let pawns = board.pieces[piece_index(color, PAWN)];
    let dr: i8 = if color == Color::White { 1 } else { -1 };
    let nr = krank as i8 + dr;
    if (0..8).contains(&nr) {
        for df in [-1i8, 0, 1] {
            let f = kfile as i8 + df;
            if !(0..8).contains(&f) {
                continue;
            }
            let sq = make_square(f as u8, nr as u8);
            if pawns & bit(sq) != 0 {
                *mg += sign * 8;
            }
        }
    }
    // A king that has walked into the middle early is a target, not a fortress.
    let home: i8 = if color == Color::White { 0 } else { 7 };
    if (krank as i8 - home).abs() > 1 && board.fullmove < 30 {
        *mg -= sign * 12;
    }
}

fn mobility(board: &Board, color: Color, sign: i32, mg: &mut i32, eg: &mut i32) {
    let t = tables();
    let own = board.occ[color.idx()];
    let mut knights = board.pieces[piece_index(color, KNIGHT)];
    while knights != 0 {
        let sq = pop_lsb(&mut knights);
        let n = (t.knight[sq as usize] & !own).count_ones() as i32;
        *mg += sign * n * 2;
        *eg += sign * n * 2;
    }
    let mut bishops = board.pieces[piece_index(color, BISHOP)];
    while bishops != 0 {
        let sq = pop_lsb(&mut bishops);
        let n = (board.attacks_by(sq, BISHOP, color) & !own).count_ones() as i32;
        *mg += sign * n * 2;
        *eg += sign * n * 2;
    }
    let mut rooks = board.pieces[piece_index(color, ROOK)];
    while rooks != 0 {
        let sq = pop_lsb(&mut rooks);
        let n = (board.attacks_by(sq, ROOK, color) & !own).count_ones() as i32;
        *mg += sign * n * 3;
        *eg += sign * n * 2;
    }
    let mut queens = board.pieces[piece_index(color, QUEEN)];
    while queens != 0 {
        let sq = pop_lsb(&mut queens);
        let n = (board.attacks_by(sq, QUEEN, color) & !own).count_ones() as i32;
        *mg += sign * n;
        *eg += sign * n;
    }
}

/// Evaluate a position from the side-to-move's point of view, in centipawns.
pub fn evaluate(board: &Board) -> i32 {
    let (mg, eg, phase) = evaluate_both(board);
    let phase = phase.clamp(0, MAX_PHASE);
    let score = (mg * phase + eg * (MAX_PHASE - phase)) / MAX_PHASE;
    if board.side == Color::White {
        score
    } else {
        -score
    }
}

/// (middlegame score, endgame score, phase) from White's point of view.
pub fn evaluate_both(board: &Board) -> (i32, i32, i32) {
    let mut mg = 0i32;
    let mut eg = 0i32;
    let mut phase = 0i32;

    for pt in [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING] {
        phase += PHASE_WEIGHT[pt] * board.pieces[piece_index(Color::White, pt)].count_ones() as i32;
        phase += PHASE_WEIGHT[pt] * board.pieces[piece_index(Color::Black, pt)].count_ones() as i32;
    }

    let mg_tables: [&[i32; 64]; 6] = [&MG_PAWN, &MG_KNIGHT, &MG_BISHOP, &MG_ROOK, &MG_QUEEN, &MG_KING];
    let eg_tables: [&[i32; 64]; 6] = [&EG_PAWN, &EG_KNIGHT, &EG_BISHOP, &EG_ROOK, &EG_QUEEN, &EG_KING];

    for color in [Color::White, Color::Black] {
        let sign = if color == Color::White { 1 } else { -1 };
        let index_fn = if color == Color::White {
            |sq: u8| sq as usize
        } else {
            |sq: u8| mirror(sq)
        };

        for pt in [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING] {
            let mut rest = board.pieces[piece_index(color, pt)];
            while rest != 0 {
                let sq = pop_lsb(&mut rest);
                mg += sign * (MG_VALUE[pt] + mg_tables[pt][index_fn(sq)]);
                eg += sign * (EG_VALUE[pt] + eg_tables[pt][index_fn(sq)]);
            }
        }
    }

    // Bishop pair.
    for color in [Color::White, Color::Black] {
        let sign = if color == Color::White { 1 } else { -1 };
        if board.pieces[piece_index(color, BISHOP)].count_ones() >= 2 {
            mg += sign * 30;
            eg += sign * 45;
        }
    }

    pawn_terms(board, Color::White, 1, &mut mg, &mut eg);
    pawn_terms(board, Color::Black, -1, &mut mg, &mut eg);
    rook_terms(board, Color::White, 1, &mut mg, &mut eg);
    rook_terms(board, Color::Black, -1, &mut mg, &mut eg);
    king_safety(board, Color::White, 1, &mut mg);
    king_safety(board, Color::Black, -1, &mut mg);
    // MOBILITY_OFF

    // Tempo: the side to move is a hair better off.
    if board.side == Color::White {
        mg += 8;
    } else {
        mg -= 8;
    }

    (mg, eg, phase)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symmetric_position_evaluates_near_zero() {
        let b = Board::startpos();
        assert!(evaluate(&b).abs() < 30, "startpos eval {}", evaluate(&b));
    }

    #[test]
    fn extra_queen_is_worth_about_a_queen() {
        let with = Board::from_fen("4k3/8/8/8/8/8/8/3QK3 w - - 0 1").unwrap();
        let without = Board::from_fen("4k3/8/8/8/8/8/8/4K3 w - - 0 1").unwrap();
        assert!(evaluate(&with) - evaluate(&without) > 800);
    }

    #[test]
    fn eval_is_symmetric_under_colour_flip() {
        let b = Board::from_fen("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1").unwrap();
        let b2 = Board::from_fen("4k3/4p3/8/8/8/8/8/4K3 b - - 0 1").unwrap();
        assert!(evaluate(&b) > 80, "a pawn up should be clearly better");
        // Both are "a pawn up for the side to move", so both are positive.
        assert_eq!(evaluate(&b), evaluate(&b2));
    }
}
