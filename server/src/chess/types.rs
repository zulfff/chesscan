//! Small value types shared by the board, the move generator and the search.
//!
//! Squares are 0..63 with a1 = 0, b1 = 1, … h8 = 63, so `rank * 8 + file`.
//! This is the layout every bitboard trick below assumes.

pub type Bitboard = u64;

pub const WHITE: usize = 0;
pub const BLACK: usize = 1;

pub const PAWN: usize = 0;
pub const KNIGHT: usize = 1;
pub const BISHOP: usize = 2;
pub const ROOK: usize = 3;
pub const QUEEN: usize = 4;
pub const KING: usize = 5;

pub const NO_SQUARE: u8 = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Color {
    White = 0,
    Black = 1,
}

impl Color {
    #[inline]
    pub fn idx(self) -> usize {
        self as usize
    }

    #[inline]
    pub fn opposite(self) -> Color {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }
}

#[inline]
pub fn file_of(sq: u8) -> u8 {
    sq & 7
}

#[inline]
pub fn rank_of(sq: u8) -> u8 {
    sq >> 3
}

#[inline]
pub fn make_square(file: u8, rank: u8) -> u8 {
    rank * 8 + file
}

#[inline]
pub fn bit(sq: u8) -> Bitboard {
    1u64 << sq
}

#[inline]
pub fn pop_lsb(bb: &mut Bitboard) -> u8 {
    let sq = bb.trailing_zeros() as u8;
    *bb &= *bb - 1;
    sq
}

pub fn square_name(sq: u8) -> String {
    let files = b"abcdefgh";
    let f = files[(sq & 7) as usize] as char;
    let r = (b'1' + (sq >> 3)) as char;
    format!("{f}{r}")
}

pub fn parse_square(s: &str) -> Option<u8> {
    let b = s.as_bytes();
    if b.len() != 2 {
        return None;
    }
    let f = b[0].checked_sub(b'a')?;
    let r = b[1].checked_sub(b'1')?;
    if f > 7 || r > 7 {
        return None;
    }
    Some(make_square(f, r))
}

pub const KIND_NORMAL: u8 = 0;
pub const KIND_DOUBLE: u8 = 1;
pub const KIND_EP: u8 = 2;
pub const KIND_CASTLE: u8 = 3;

/// Packed move: from(6) | to(6) | promo(3) | kind(3).
///
/// `promo` is 0 for a non-promotion, otherwise 1..=4 for N, B, R, Q.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Default)]
pub struct Move(pub u32);

impl Move {
    #[inline]
    pub fn new(from: u8, to: u8, promo: u8, kind: u8) -> Move {
        Move((from as u32) | ((to as u32) << 6) | ((promo as u32) << 12) | ((kind as u32) << 15))
    }

    #[inline]
    pub fn from(self) -> u8 {
        (self.0 & 63) as u8
    }

    #[inline]
    pub fn to(self) -> u8 {
        ((self.0 >> 6) & 63) as u8
    }

    #[inline]
    pub fn promo(self) -> u8 {
        ((self.0 >> 12) & 7) as u8
    }

    #[inline]
    pub fn kind(self) -> u8 {
        ((self.0 >> 15) & 7) as u8
    }

    #[inline]
    pub fn is_promotion(self) -> bool {
        self.promo() != 0
    }

    #[inline]
    pub fn is_castle(self) -> bool {
        self.kind() == KIND_CASTLE
    }

    pub fn uci(self) -> String {
        let mut s = format!("{}{}", square_name(self.from()), square_name(self.to()));
        match self.promo() {
            1 => s.push('n'),
            2 => s.push('b'),
            3 => s.push('r'),
            4 => s.push('q'),
            _ => {}
        }
        s
    }

    pub fn parse_uci(s: &str) -> Option<Move> {
        let bytes = s.as_bytes();
        if bytes.len() < 4 {
            return None;
        }
        let from = parse_square(&s[0..2])?;
        let to = parse_square(&s[2..4])?;
        let promo = match bytes.get(4).copied() {
            None => 0,
            Some(b'n') | Some(b'N') => 1,
            Some(b'b') | Some(b'B') => 2,
            Some(b'r') | Some(b'R') => 3,
            Some(b'q') | Some(b'Q') => 4,
            _ => return None,
        };
        Some(Move::new(from, to, promo, KIND_NORMAL))
    }
}

/// Piece as it sits in the 12-entry `pieces` array: color * 6 + type.
#[inline]
pub fn piece_index(color: Color, pt: usize) -> usize {
    color.idx() * 6 + pt
}

#[inline]
pub fn piece_color(index: usize) -> Color {
    if index < 6 {
        Color::White
    } else {
        Color::Black
    }
}

#[inline]
pub fn piece_type(index: usize) -> usize {
    index % 6
}
