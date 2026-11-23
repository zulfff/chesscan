//! The board: position, FEN, move making, attack detection, hashing.
//!
//! Copy-make, not make/unmake. The board is ~200 bytes and a search node costs
//! far more in move generation than a memcpy, so the simpler and much harder
//! to get wrong representation wins. Do not "optimise" this into an unmake
//! stack without perft tests under it; the whole point of this file is that
//! `make_move` is not allowed to be clever.

use std::sync::OnceLock;

use super::movelist::MoveList;
use super::types::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Board {
    /// pieces[color*6 + type] -> bitboard of that piece.
    pub pieces: [Bitboard; 12],
    /// occupancy per color.
    pub occ: [Bitboard; 2],
    /// all occupied squares.
    pub all: Bitboard,
    /// squares[sq] = 1 + piece index, 0 when empty. Kept in sync with `pieces`.
    pub squares: [u8; 64],
    pub side: Color,
    /// Castling rights: 1 = white kingside, 2 = white queenside, 4 = black
    /// kingside, 8 = black queenside.
    pub castling: u8,
    /// En-passant target square, or NO_SQUARE.
    pub ep: u8,
    pub halfmove: u16,
    pub fullmove: u16,
    pub hash: u64,
}

/// Everything needed to undo a move without cloning the board.
#[derive(Clone, Copy, Debug)]
pub struct Undo {
    pub from: u8,
    pub to: u8,
    pub moved_idx: usize,
    pub captured_sq: u8,
    pub captured_idx: usize,
    pub castling: u8,
    pub ep: u8,
    pub halfmove: u16,
    pub hash: u64,
    pub fullmove: u16,
    pub rook_from: u8,
    pub rook_to: u8,
}

impl Default for Board {
    fn default() -> Self {
        Self::startpos()
    }
}

// --- attack tables ---------------------------------------------------------

pub struct Tables {
    pub knight: [Bitboard; 64],
    pub king: [Bitboard; 64],
    pub pawn: [[Bitboard; 64]; 2],
}

fn knight_mask(sq: u8) -> Bitboard {
    let f = file_of(sq) as i8;
    let r = rank_of(sq) as i8;
    let deltas = [
        (1, 2),
        (2, 1),
        (2, -1),
        (1, -2),
        (-1, -2),
        (-2, -1),
        (-2, 1),
        (-1, 2),
    ];
    let mut bb = 0u64;
    for (df, dr) in deltas {
        let nf = f + df;
        let nr = r + dr;
        if (0..8).contains(&nf) && (0..8).contains(&nr) {
            bb |= bit(make_square(nf as u8, nr as u8));
        }
    }
    bb
}

fn king_mask(sq: u8) -> Bitboard {
    let f = file_of(sq) as i8;
    let r = rank_of(sq) as i8;
    let mut bb = 0u64;
    for df in -1..=1 {
        for dr in -1..=1 {
            if df == 0 && dr == 0 {
                continue;
            }
            let nf = f + df;
            let nr = r + dr;
            if (0..8).contains(&nf) && (0..8).contains(&nr) {
                bb |= bit(make_square(nf as u8, nr as u8));
            }
        }
    }
    bb
}

fn pawn_mask(sq: u8, color: Color) -> Bitboard {
    let f = file_of(sq) as i8;
    let r = rank_of(sq) as i8;
    let dr = match color {
        Color::White => 1,
        Color::Black => -1,
    };
    let mut bb = 0u64;
    for df in [-1, 1] {
        let nf = f + df;
        let nr = r + dr;
        if (0..8).contains(&nf) && (0..8).contains(&nr) {
            bb |= bit(make_square(nf as u8, nr as u8));
        }
    }
    bb
}

pub fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut knight = [0u64; 64];
        let mut king = [0u64; 64];
        let mut pawn = [[0u64; 64]; 2];
        for sq in 0..64u8 {
            knight[sq as usize] = knight_mask(sq);
            king[sq as usize] = king_mask(sq);
            pawn[Color::White.idx()][sq as usize] = pawn_mask(sq, Color::White);
            pawn[Color::Black.idx()][sq as usize] = pawn_mask(sq, Color::Black);
        }
        Tables { knight, king, pawn }
    })
}

/// Ray attacks from `sq` in one direction, blocked by `occ` (the blocker itself
/// is included, which is what a capture generator wants).
#[inline]
pub fn ray_attacks(sq: u8, occ: Bitboard, df: i8, dr: i8) -> Bitboard {
    let mut bb = 0u64;
    let mut f = file_of(sq) as i8;
    let mut r = rank_of(sq) as i8;
    loop {
        f += df;
        r += dr;
        if !(0..8).contains(&f) || !(0..8).contains(&r) {
            break;
        }
        let target = make_square(f as u8, r as u8);
        bb |= bit(target);
        if occ & bit(target) != 0 {
            break;
        }
    }
    bb
}

pub const ROOK_DIRS: [(i8, i8); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
pub const BISHOP_DIRS: [(i8, i8); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];

// --- zobrist ---------------------------------------------------------------

struct Zobrist {
    pieces: [[u64; 64]; 12],
    side: u64,
    castle: [u64; 16],
    ep: [u64; 8],
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn zobrist() -> &'static Zobrist {
    static Z: OnceLock<Zobrist> = OnceLock::new();
    Z.get_or_init(|| {
        let mut state = 0xC0FF_EE12_3456_789Au64;
        let mut pieces = [[0u64; 64]; 12];
        for p in pieces.iter_mut() {
            for v in p.iter_mut() {
                *v = splitmix64(&mut state);
            }
        }
        let mut castle = [0u64; 16];
        for v in castle.iter_mut() {
            *v = splitmix64(&mut state);
        }
        let mut ep = [0u64; 8];
        for v in ep.iter_mut() {
            *v = splitmix64(&mut state);
        }
        Zobrist {
            pieces,
            side: splitmix64(&mut state),
            castle,
            ep,
        }
    })
}

// --- construction ----------------------------------------------------------

impl Board {
    pub fn empty() -> Board {
        Board {
            pieces: [0; 12],
            occ: [0; 2],
            all: 0,
            squares: [0; 64],
            side: Color::White,
            castling: 0,
            ep: NO_SQUARE,
            halfmove: 0,
            fullmove: 1,
            hash: 0,
        }
    }

    pub fn startpos() -> Board {
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        Board::from_fen(fen).expect("startpos is valid")
    }

    pub fn from_fen(fen: &str) -> Result<Board, String> {
        let mut b = Board::empty();
        let parts: Vec<&str> = fen.split_whitespace().collect();
        if parts.len() < 4 {
            return Err(format!("FEN needs at least 4 fields, got '{fen}'"));
        }

        let rows: Vec<&str> = parts[0].split('/').collect();
        if rows.len() != 8 {
            return Err(format!("FEN piece field needs 8 ranks, got '{}'", parts[0]));
        }
        for (i, row) in rows.iter().enumerate() {
            let rank = 7 - i as u8;
            let mut file = 0u8;
            for ch in row.chars() {
                if let Some(d) = ch.to_digit(10) {
                    file += d as u8;
                    continue;
                }
                let color = if ch.is_ascii_uppercase() {
                    Color::White
                } else {
                    Color::Black
                };
                let pt = match ch.to_ascii_lowercase() {
                    'p' => PAWN,
                    'n' => KNIGHT,
                    'b' => BISHOP,
                    'r' => ROOK,
                    'q' => QUEEN,
                    'k' => KING,
                    other => return Err(format!("unknown piece '{other}' in FEN")),
                };
                if file > 7 {
                    return Err(format!("rank {rank} overflows the board"));
                }
                let sq = make_square(file, rank);
                b.put_piece(sq, color, pt);
                file += 1;
            }
            if file != 8 {
                return Err(format!("rank {rank} has {file} files, expected 8"));
            }
        }

        b.side = match parts[1] {
            "w" => Color::White,
            "b" => Color::Black,
            other => return Err(format!("side to move must be 'w' or 'b', got '{other}'")),
        };

        b.castling = 0;
        if parts[2] != "-" {
            for ch in parts[2].chars() {
                match ch {
                    'K' => b.castling |= 1,
                    'Q' => b.castling |= 2,
                    'k' => b.castling |= 4,
                    'q' => b.castling |= 8,
                    other => return Err(format!("unknown castling right '{other}'")),
                }
            }
        }

        b.ep = if parts[3] == "-" {
            NO_SQUARE
        } else {
            parse_square(parts[3]).ok_or_else(|| format!("bad en-passant square '{}'", parts[3]))?
        };

        b.halfmove = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
        b.fullmove = parts.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);

        // A position with a missing king is not a position.
        for color in [Color::White, Color::Black] {
            if b.pieces[piece_index(color, KING)] == 0 {
                return Err("FEN has no king for one side".into());
            }
        }

        b.recompute_hash();
        Ok(b)
    }

    pub fn to_fen(&self) -> String {
        let mut rows = Vec::new();
        for rank in (0..8).rev() {
            let mut row = String::new();
            let mut empty = 0;
            for file in 0..8 {
                let sq = make_square(file, rank);
                match self.piece_at(sq) {
                    Some((color, pt)) => {
                        if empty > 0 {
                            row.push_str(&empty.to_string());
                            empty = 0;
                        }
                        let ch = match pt {
                            PAWN => 'p',
                            KNIGHT => 'n',
                            BISHOP => 'b',
                            ROOK => 'r',
                            QUEEN => 'q',
                            KING => 'k',
                            _ => unreachable!(),
                        };
                        row.push(if color == Color::White {
                            ch.to_ascii_uppercase()
                        } else {
                            ch
                        });
                    }
                    None => empty += 1,
                }
            }
            if empty > 0 {
                row.push_str(&empty.to_string());
            }
            rows.push(row);
        }

        let mut castling = String::new();
        if self.castling & 1 != 0 {
            castling.push('K');
        }
        if self.castling & 2 != 0 {
            castling.push('Q');
        }
        if self.castling & 4 != 0 {
            castling.push('k');
        }
        if self.castling & 8 != 0 {
            castling.push('q');
        }
        if castling.is_empty() {
            castling.push('-');
        }

        let ep = if self.ep == NO_SQUARE {
            "-".to_string()
        } else {
            square_name(self.ep)
        };

        format!(
            "{} {} {} {} {} {}",
            rows.join("/"),
            if self.side == Color::White { "w" } else { "b" },
            castling,
            ep,
            self.halfmove,
            self.fullmove
        )
    }

    // --- piece placement ----------------------------------------------------

    fn put_piece(&mut self, sq: u8, color: Color, pt: usize) {
        let idx = piece_index(color, pt);
        self.pieces[idx] |= bit(sq);
        self.occ[color.idx()] |= bit(sq);
        self.all |= bit(sq);
        self.squares[sq as usize] = (idx + 1) as u8;
    }

    fn remove_piece(&mut self, sq: u8) -> Option<usize> {
        let idx = (self.squares[sq as usize] as usize).checked_sub(1)?;
        self.squares[sq as usize] = 0;
        self.pieces[idx] &= !bit(sq);
        let color = piece_color(idx);
        self.occ[color.idx()] &= !bit(sq);
        self.all &= !bit(sq);
        Some(idx)
    }

    pub fn piece_at(&self, sq: u8) -> Option<(Color, usize)> {
        let v = self.squares[sq as usize];
        if v == 0 {
            return None;
        }
        let idx = v as usize - 1;
        Some((piece_color(idx), piece_type(idx)))
    }

    #[inline]
    pub fn king_square(&self, color: Color) -> u8 {
        self.pieces[piece_index(color, KING)].trailing_zeros() as u8
    }

    #[inline]
    pub fn occupancy(&self) -> Bitboard {
        self.all
    }

    // --- attacks -----------------------------------------------------------

    pub fn is_attacked(&self, sq: u8, by: Color) -> bool {
        let t = tables();
        // Pawns: squares from which a pawn of colour `by` attacks `sq`.
        if t.pawn[by.opposite().idx()][sq as usize] & self.pieces[piece_index(by, PAWN)] != 0 {
            return true;
        }
        if t.knight[sq as usize] & self.pieces[piece_index(by, KNIGHT)] != 0 {
            return true;
        }
        if t.king[sq as usize] & self.pieces[piece_index(by, KING)] != 0 {
            return true;
        }
        let rook_like = self.pieces[piece_index(by, ROOK)] | self.pieces[piece_index(by, QUEEN)];
        for (df, dr) in ROOK_DIRS {
            if ray_attacks(sq, self.all, df, dr) & rook_like != 0 {
                return true;
            }
        }
        let bishop_like =
            self.pieces[piece_index(by, BISHOP)] | self.pieces[piece_index(by, QUEEN)];
        for (df, dr) in BISHOP_DIRS {
            if ray_attacks(sq, self.all, df, dr) & bishop_like != 0 {
                return true;
            }
        }
        false
    }

    #[inline]
    pub fn in_check(&self, color: Color) -> bool {
        let k = self.king_square(color);
        self.is_attacked(k, color.opposite())
    }

    /// Pseudo-legal attacks by `pt` on `sq`, not filtered for pins.
    pub fn attacks_by(&self, sq: u8, pt: usize, color: Color) -> Bitboard {
        let t = tables();
        match pt {
            PAWN => t.pawn[color.idx()][sq as usize],
            KNIGHT => t.knight[sq as usize],
            KING => t.king[sq as usize],
            BISHOP => BISHOP_DIRS
                .iter()
                .fold(0u64, |acc, (df, dr)| acc | ray_attacks(sq, self.all, *df, *dr)),
            ROOK => ROOK_DIRS
                .iter()
                .fold(0u64, |acc, (df, dr)| acc | ray_attacks(sq, self.all, *df, *dr)),
            QUEEN => BISHOP_DIRS
                .iter()
                .chain(ROOK_DIRS.iter())
                .fold(0u64, |acc, (df, dr)| acc | ray_attacks(sq, self.all, *df, *dr)),
            _ => 0,
        }
    }

    // --- hashing -----------------------------------------------------------

    pub fn recompute_hash(&mut self) {
        let z = zobrist();
        let mut h = 0u64;
        for (idx, bb) in self.pieces.iter().enumerate() {
            let mut rest = *bb;
            while rest != 0 {
                let sq = pop_lsb(&mut rest);
                h ^= z.pieces[idx][sq as usize];
            }
        }
        if self.side == Color::Black {
            h ^= z.side;
        }
        h ^= z.castle[self.castling as usize];
        if self.ep != NO_SQUARE {
            h ^= z.ep[file_of(self.ep) as usize];
        }
        self.hash = h;
    }

    // --- move making -------------------------------------------------------

    /// Apply a pseudo-legal move. Callers that need legality use
    /// [`Board::is_legal`] or filter through the move generator.
    pub fn make_move(&mut self, m: Move) -> Undo {
        let z = zobrist();
        let from = m.from();
        let to = m.to();
        let us = self.side;
        let them = us.opposite();

        let idx = (self.squares[from as usize] as usize)
            .saturating_sub(1);
        debug_assert!(self.squares[from as usize] != 0, "make_move on an empty square");
        let pt = piece_type(idx);
        let is_capture = m.kind() == KIND_EP || self.piece_at(to).is_some();

        let undo_castling = self.castling;
        let undo_ep = self.ep;
        let undo_halfmove = self.halfmove;
        let undo_hash = self.hash;
        let undo_fullmove = self.fullmove;
        let mut captured_sq = NO_SQUARE;
        let mut captured_idx = 0usize;

        // En passant capture removes a pawn that is not on the target square.
        if m.kind() == KIND_EP {
            let victim_sq = if us == Color::White { to - 8 } else { to + 8 };
            if let Some(captured) = self.remove_piece(victim_sq) {
                self.hash ^= z.pieces[captured][victim_sq as usize];
                captured_sq = victim_sq;
                captured_idx = captured;
            }
        } else if let Some(captured) = self.remove_piece(to) {
            self.hash ^= z.pieces[captured][to as usize];
            captured_sq = to;
            captured_idx = captured;
        }

        // Move the piece itself.
        self.remove_piece(from);
        let landing = if m.is_promotion() {
            match m.promo() {
                1 => KNIGHT,
                2 => BISHOP,
                3 => ROOK,
                4 => QUEEN,
                _ => QUEEN,
            }
        } else {
            pt
        };
        self.put_piece(to, us, landing);
        self.hash ^= z.pieces[idx][from as usize];
        self.hash ^= z.pieces[piece_index(us, landing)][to as usize];

        // Castling moves the rook too.
        let mut rook_from = NO_SQUARE;
        let mut rook_to = NO_SQUARE;
        if m.kind() == KIND_CASTLE {
            let (rf, rt) = if file_of(to) == 6 { (7, 5) } else { (0, 3) };
            let rank = rank_of(to);
            let rf_sq = make_square(rf, rank);
            let rt_sq = make_square(rt, rank);
            let rook = piece_index(us, ROOK);
            self.remove_piece(rf_sq);
            self.put_piece(rt_sq, us, ROOK);
            self.hash ^= z.pieces[rook][rf_sq as usize];
            self.hash ^= z.pieces[rook][rt_sq as usize];
            rook_from = rf_sq;
            rook_to = rt_sq;
        }

        // Castling rights.
        let mut new_rights = self.castling;
        if pt == KING {
            new_rights &= if us == Color::White { !(1 | 2) } else { !(4 | 8) };
        }
        if pt == ROOK {
            new_rights &= match from {
                0 => !2,
                7 => !1,
                56 => !8,
                63 => !4,
                _ => new_rights,
            };
        }
        // Losing a rook on its home square forfeits that right.
        new_rights &= match to {
            0 => !2,
            7 => !1,
            56 => !8,
            63 => !4,
            _ => new_rights,
        };
        if new_rights != self.castling {
            self.hash ^= z.castle[self.castling as usize];
            self.castling = new_rights;
            self.hash ^= z.castle[self.castling as usize];
        }

        // En passant target.
        self.hash ^= match self.ep {
            NO_SQUARE => 0,
            sq => z.ep[file_of(sq) as usize],
        };
        self.ep = if m.kind() == KIND_DOUBLE {
            if us == Color::White { from + 8 } else { from - 8 }
        } else {
            NO_SQUARE
        };
        self.hash ^= match self.ep {
            NO_SQUARE => 0,
            sq => z.ep[file_of(sq) as usize],
        };

        self.halfmove = if pt == PAWN || is_capture { 0 } else { self.halfmove + 1 };
        if us == Color::Black {
            self.fullmove += 1;
        }

        self.hash ^= z.side;
        self.side = them;

        Undo {
            from,
            to,
            moved_idx: idx,
            captured_sq,
            captured_idx,
            castling: undo_castling,
            ep: undo_ep,
            halfmove: undo_halfmove,
            hash: undo_hash,
            fullmove: undo_fullmove,
            rook_from,
            rook_to,
        }
    }

    pub fn unmake_move(&mut self, _m: Move, u: &Undo) {
        let us = self.side.opposite();
        self.side = us;
        self.castling = u.castling;
        self.ep = u.ep;
        self.halfmove = u.halfmove;
        self.fullmove = u.fullmove;
        self.hash = u.hash;

        self.remove_piece(u.to);
        self.put_piece(u.from, us, piece_type(u.moved_idx));

        if u.captured_sq != NO_SQUARE {
            self.put_piece(u.captured_sq, us.opposite(), piece_type(u.captured_idx));
        }
        if u.rook_from != NO_SQUARE {
            self.remove_piece(u.rook_to);
            self.put_piece(u.rook_from, us, ROOK);
        }
    }

    /// True when the move does not leave the mover's king in check.
    pub fn is_legal(&self, m: Move) -> bool {
        let us = self.side;
        let mut next = self.clone();
        let u = next.make_move(m);
        let legal = !next.is_attacked(next.king_square(us), us.opposite());
        let _ = u;
        legal
    }

    /// Filter a pseudo-legal list, undoing each move instead of cloning the
    /// board per candidate. This is the hot path of every move generator call.
    pub fn filter_legal(&self, pseudo: MoveList) -> MoveList {
        let us = self.side;
        let mut board = self.clone();
        let mut out = MoveList::new();
        for m in pseudo.iter().copied() {
            let u = board.make_move(m);
            let legal = !board.is_attacked(board.king_square(us), us.opposite());
            board.unmake_move(m, &u);
            if legal {
                out.push(m);
            }
        }
        out
    }

    pub fn is_capture(&self, m: Move) -> bool {
        if m.kind() == KIND_EP {
            return true;
        }
        self.piece_at(m.to()).is_some()
    }

    /// Number of pieces of both colours.
    pub fn piece_count(&self) -> u32 {
        self.all.count_ones()
    }

    pub fn has_non_pawn_material(&self, color: Color) -> bool {
        for pt in [KNIGHT, BISHOP, ROOK, QUEEN] {
            if self.pieces[piece_index(color, pt)] != 0 {
                return true;
            }
        }
        false
    }

    /// Material-only draw detection, used by the search's draw checks.
    pub fn is_insufficient_material(&self) -> bool {
        if self.pieces[piece_index(Color::White, PAWN)]
            | self.pieces[piece_index(Color::Black, PAWN)]
            | self.pieces[piece_index(Color::White, ROOK)]
            | self.pieces[piece_index(Color::Black, ROOK)]
            | self.pieces[piece_index(Color::White, QUEEN)]
            | self.pieces[piece_index(Color::Black, QUEEN)]
            != 0
        {
            return false;
        }
        let wn = self.pieces[piece_index(Color::White, KNIGHT)].count_ones();
        let bn = self.pieces[piece_index(Color::Black, KNIGHT)].count_ones();
        let wb = self.pieces[piece_index(Color::White, BISHOP)].count_ones();
        let bb = self.pieces[piece_index(Color::Black, BISHOP)].count_ones();
        let light = (wb + bb) == 1 && wn == 0 && bn == 0;
        let knights = wn + bn <= 1;
        let bishops = wb + bb <= 1 && wn == 0 && bn == 0;
        // K+B vs K+B on the same colour is a draw too, but only when neither
        // side has a knight; the common cases above cover the rest.
        (light || knights || bishops) && (wb + bb + wn + bn) <= 2
    }
}
