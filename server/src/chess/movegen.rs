//! Move generation.
//!
//! Pseudo-legal by default, with a separate legal filter. Pins and checks are
//! resolved by making the move and asking the board whether the king is
//! attacked; that is slower than a pin mask but it is the version that cannot
//! have an off-by-one on the a-file, and perft is what proves it.

use super::board::{ray_attacks, tables, Board, ROOK_DIRS, BISHOP_DIRS};
use super::movelist::MoveList;
use super::types::*;

pub fn generate(board: &Board, captures_only: bool) -> MoveList {
    let mut moves = MoveList::new();
    let us = board.side;
    let them = us.opposite();
    let own = board.occ[us.idx()];
    // A king is never a capturable target. A position where it is would be
    // illegal, and generating such a move corrupts every downstream check.
    let enemy = board.occ[them.idx()] & !board.pieces[piece_index(them, KING)];
    let empty = !board.all;
    let t = tables();

    // --- pawns -------------------------------------------------------------
    let mut rest = board.pieces[piece_index(us, PAWN)];
    while rest != 0 {
        let from = pop_lsb(&mut rest);
        let rank = rank_of(from);
        let promo_rank = if us == Color::White { 7 } else { 0 };

        // Captures (including en passant).
        let mut caps = t.pawn[us.idx()][from as usize] & enemy;
        if board.ep != NO_SQUARE && t.pawn[us.idx()][from as usize] & bit(board.ep) != 0 {
            caps |= bit(board.ep);
        }
        let mut cap_rest = caps;
        while cap_rest != 0 {
            let to = pop_lsb(&mut cap_rest);
            let kind = if to == board.ep && rank_of(to) != promo_rank {
                KIND_EP
            } else {
                KIND_NORMAL
            };
            if rank_of(to) == promo_rank {
                for promo in 1..=4u8 {
                    moves.push(Move::new(from, to, promo, kind));
                }
            } else {
                moves.push(Move::new(from, to, 0, kind));
            }
        }

        if captures_only {
            continue;
        }

        // Single push.
        let up = if us == Color::White { from + 8 } else { from - 8 };
        if empty & bit(up) != 0 {
            if rank_of(up) == promo_rank {
                for promo in 1..=4u8 {
                    moves.push(Move::new(from, up, promo, KIND_NORMAL));
                }
            } else {
                moves.push(Move::new(from, up, 0, KIND_NORMAL));
                // Double push from the second rank.
                let start_rank = if us == Color::White { 1 } else { 6 };
                if rank == start_rank {
                    let up2 = if us == Color::White { from + 16 } else { from - 16 };
                    if empty & bit(up2) != 0 {
                        moves.push(Move::new(from, up2, 0, KIND_DOUBLE));
                    }
                }
            }
        }
    }

    // --- knights -----------------------------------------------------------
    let mut rest = board.pieces[piece_index(us, KNIGHT)];
    while rest != 0 {
        let from = pop_lsb(&mut rest);
        let mut att = t.knight[from as usize] & !own;
        if captures_only {
            att &= enemy;
        }
        while att != 0 {
            let to = pop_lsb(&mut att);
            moves.push(Move::new(from, to, 0, KIND_NORMAL));
        }
    }

    // --- bishops -----------------------------------------------------------
    let mut rest = board.pieces[piece_index(us, BISHOP)];
    while rest != 0 {
        let from = pop_lsb(&mut rest);
        let mut att = 0u64;
        for (df, dr) in BISHOP_DIRS {
            att |= ray_attacks(from, board.all, df, dr);
        }
        att &= !own;
        if captures_only {
            att &= enemy;
        }
        while att != 0 {
            let to = pop_lsb(&mut att);
            moves.push(Move::new(from, to, 0, KIND_NORMAL));
        }
    }

    // --- rooks -------------------------------------------------------------
    let mut rest = board.pieces[piece_index(us, ROOK)];
    while rest != 0 {
        let from = pop_lsb(&mut rest);
        let mut att = 0u64;
        for (df, dr) in ROOK_DIRS {
            att |= ray_attacks(from, board.all, df, dr);
        }
        att &= !own;
        if captures_only {
            att &= enemy;
        }
        while att != 0 {
            let to = pop_lsb(&mut att);
            moves.push(Move::new(from, to, 0, KIND_NORMAL));
        }
    }

    // --- queens ------------------------------------------------------------
    let mut rest = board.pieces[piece_index(us, QUEEN)];
    while rest != 0 {
        let from = pop_lsb(&mut rest);
        let mut att = 0u64;
        for (df, dr) in BISHOP_DIRS.iter().chain(ROOK_DIRS.iter()) {
            att |= ray_attacks(from, board.all, *df, *dr);
        }
        att &= !own;
        if captures_only {
            att &= enemy;
        }
        while att != 0 {
            let to = pop_lsb(&mut att);
            moves.push(Move::new(from, to, 0, KIND_NORMAL));
        }
    }

    // --- king --------------------------------------------------------------
    let from = board.king_square(us);
    let mut att = t.king[from as usize] & !own;
    if captures_only {
        att &= enemy;
    }
    while att != 0 {
        let to = pop_lsb(&mut att);
        moves.push(Move::new(from, to, 0, KIND_NORMAL));
    }

    if !captures_only {
        castling(board, us, &mut moves);
    }

    moves
}

fn castling(board: &Board, us: Color, moves: &mut MoveList) {
    let them = us.opposite();
    let home_rank = if us == Color::White { 0 } else { 7 };
    let (kbit, qbit) = if us == Color::White { (1u8, 2u8) } else { (4, 8) };
    let ksq = make_square(4, home_rank);

    if board.piece_at(ksq) != Some((us, KING)) {
        return;
    }
    if board.is_attacked(ksq, them) {
        return;
    }

    // Kingside.
    if board.castling & kbit != 0 {
        let f = make_square(5, home_rank);
        let g = make_square(6, home_rank);
        let h = make_square(7, home_rank);
        if board.squares[f as usize] == 0
            && board.squares[g as usize] == 0
            && board.piece_at(h) == Some((us, ROOK))
            && !board.is_attacked(f, them)
            && !board.is_attacked(g, them)
        {
            moves.push(Move::new(ksq, g, 0, KIND_CASTLE));
        }
    }

    // Queenside.
    if board.castling & qbit != 0 {
        let d = make_square(3, home_rank);
        let c = make_square(2, home_rank);
        let b = make_square(1, home_rank);
        let a = make_square(0, home_rank);
        if board.squares[d as usize] == 0
            && board.squares[c as usize] == 0
            && board.squares[b as usize] == 0
            && board.piece_at(a) == Some((us, ROOK))
            && !board.is_attacked(d, them)
            && !board.is_attacked(c, them)
        {
            moves.push(Move::new(ksq, c, 0, KIND_CASTLE));
        }
    }
}

pub fn legal_moves(board: &Board) -> MoveList {
    board.filter_legal(generate(board, false))
}

pub fn legal_captures(board: &Board) -> MoveList {
    board.filter_legal(generate(board, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perft(board: &mut Board, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let moves = legal_moves(board);
        if depth == 1 {
            return moves.len() as u64;
        }
        let mut total = 0;
        for m in moves.iter().copied() {
            let undo = board.make_move(m);
            total += perft(board, depth - 1);
            board.unmake_move(m, &undo);
        }
        total
    }

    fn perft_from_fen(fen: &str, depth: u32) -> u64 {
        let mut b = Board::from_fen(fen).unwrap();
        perft(&mut b, depth)
    }

    #[test]
    fn startpos_perft_matches_published_counts() {
        let expected = [20u64, 400, 8902, 197281];
        for (d, want) in expected.iter().enumerate() {
            let got =
                perft_from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", (d + 1) as u32);
            assert_eq!(got, *want, "startpos perft depth {}", d + 1);
        }
    }

    #[test]
    fn kiwipete_perft_matches_published_counts() {
        let fen = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
        let expected = [48u64, 2039, 97862];
        for (d, want) in expected.iter().enumerate() {
            let got = perft_from_fen(fen, (d + 1) as u32);
            assert_eq!(got, *want, "kiwipete perft depth {}", d + 1);
        }
    }

    #[test]
    fn position_three_perft_matches_published_counts() {
        let fen = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
        let expected = [14u64, 191, 2812, 43238];
        for (d, want) in expected.iter().enumerate() {
            let got = perft_from_fen(fen, (d + 1) as u32);
            assert_eq!(got, *want, "pos3 perft depth {}", d + 1);
        }
    }

    #[test]
    fn position_four_perft_matches_published_counts() {
        let fen = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1";
        let expected = [6u64, 264, 9467];
        for (d, want) in expected.iter().enumerate() {
            let got = perft_from_fen(fen, (d + 1) as u32);
            assert_eq!(got, *want, "pos4 perft depth {}", d + 1);
        }
    }

    #[test]
    fn position_five_perft_matches_published_counts() {
        let fen = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8";
        let expected = [44u64, 1486, 62379];
        for (d, want) in expected.iter().enumerate() {
            let got = perft_from_fen(fen, (d + 1) as u32);
            assert_eq!(got, *want, "pos5 perft depth {}", d + 1);
        }
    }

    #[test]
    fn fen_round_trips() {
        for fen in [
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
            "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
        ] {
            let b = Board::from_fen(fen).unwrap();
            assert_eq!(b.to_fen(), fen, "FEN must round-trip");
        }
    }

    #[test]
    fn make_and_unmake_restore_the_board_exactly() {
        for fen in [
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
            "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
            "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
            "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        ] {
            let b = Board::from_fen(fen).unwrap();
            for m in legal_moves(&b).iter().copied() {
                let mut x = b.clone();
                let u = x.make_move(m);
                x.unmake_move(m, &u);
                assert_eq!(x, b, "make/unmake of {} from {} lost information", m.uci(), fen);
                assert_eq!(x.hash, b.hash, "hash must survive make/unmake");
            }
        }
    }

    #[test]
    fn en_passant_is_generated() {
        // White pawn on e5, black pawn just played d7-d5, en passant on d6.
        let b = Board::from_fen("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3").unwrap();
        assert!(legal_moves(&b).iter().any(|m| m.uci() == "e5d6"));
        // The ordinary capture to d5 does not exist: there is no black pawn there.
        assert!(!legal_moves(&b).iter().any(|m| m.uci() == "e5d5"));
    }

    #[test]
    fn castling_is_generated_and_blocked_by_attack() {
        let b = Board::from_fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1").unwrap();
        let ucis: Vec<String> = legal_moves(&b).iter().map(|m| m.uci()).collect();
        assert!(ucis.contains(&"e1g1".to_string()));
        assert!(ucis.contains(&"e1c1".to_string()));

        // A rook staring down f1 forbids kingside castling.
        let b = Board::from_fen("4k3/8/8/8/8/8/5r2/4K2R w K - 0 1").unwrap();
        let ucis: Vec<String> = legal_moves(&b).iter().map(|m| m.uci()).collect();
        assert!(!ucis.contains(&"e1g1".to_string()));
    }

    #[test]
    fn a_pinned_piece_cannot_move_off_the_line() {
        let b = Board::from_fen("4k3/8/8/8/8/8/4r3/4K2R w - - 0 1").unwrap();
        // White is in check from the e2 rook; the king must respond, not castle.
        let ucis: Vec<String> = legal_moves(&b).iter().map(|m| m.uci()).collect();
        assert!(ucis.contains(&"e1f1".to_string()));
        assert!(!ucis.contains(&"e1g1".to_string()));
    }
}
