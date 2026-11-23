//! A fixed-capacity move list.
//!
//! Chess never has more than 218 legal moves in a position, so a stack array
//! covers every real case. Allocating a `Vec` per node was costing more time
//! than the search itself.

use super::types::Move;

pub const MAX_MOVES: usize = 256;

#[derive(Clone)]
pub struct MoveList {
    moves: [Move; MAX_MOVES],
    len: usize,
}

impl Default for MoveList {
    fn default() -> Self {
        Self::new()
    }
}

impl MoveList {
    pub fn new() -> MoveList {
        MoveList {
            moves: [Move::default(); MAX_MOVES],
            len: 0,
        }
    }

    #[inline]
    pub fn push(&mut self, m: Move) {
        debug_assert!(self.len < MAX_MOVES, "move list overflow");
        if self.len < MAX_MOVES {
            self.moves[self.len] = m;
            self.len += 1;
        }
    }

    #[inline]
    pub fn as_slice(&self) -> &[Move] {
        &self.moves[..self.len]
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub fn iter(&self) -> std::slice::Iter<'_, Move> {
        self.as_slice().iter()
    }

    pub fn into_vec(self) -> Vec<Move> {
        self.as_slice().to_vec()
    }
}

impl<'a> IntoIterator for &'a MoveList {
    type Item = &'a Move;
    type IntoIter = std::slice::Iter<'a, Move>;
    fn into_iter(self) -> Self::IntoIter {
        self.as_slice().iter()
    }
}

impl IntoIterator for MoveList {
    type Item = Move;
    type IntoIter = std::vec::IntoIter<Move>;
    fn into_iter(self) -> Self::IntoIter {
        self.as_slice().to_vec().into_iter()
    }
}
