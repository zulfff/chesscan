//! Transposition table.
//!
//! A flat array indexed by the low bits of the Zobrist hash. Replacement is
//! always-overwrite, which is the simplest policy that is still good: the
//! table is a cache, not a database, and a wrong-but-recent entry beats a
//! right-but-evicted one at these depths.

use super::types::Move;

pub const FLAG_NONE: u8 = 0;
pub const FLAG_EXACT: u8 = 1;
pub const FLAG_LOWER: u8 = 2;
pub const FLAG_UPPER: u8 = 3;

#[derive(Clone, Copy, Default)]
pub struct Entry {
    pub key: u64,
    pub mv: u32,
    pub score: i32,
    pub depth: i8,
    pub flag: u8,
}

pub struct Tt {
    entries: Vec<Entry>,
    mask: usize,
    pub probes: u64,
    pub hits: u64,
}

impl Tt {
    pub fn new(mb: usize) -> Tt {
        let bytes = mb.max(1) * 1024 * 1024;
        let mut count = bytes / std::mem::size_of::<Entry>();
        // Round down to a power of two so the index is a mask.
        count = count.next_power_of_two() / 2;
        if count == 0 {
            count = 1024;
        }
        Tt {
            entries: vec![Entry::default(); count],
            mask: count - 1,
            probes: 0,
            hits: 0,
        }
    }

    #[inline]
    fn index(&self, key: u64) -> usize {
        (key as usize) & self.mask
    }

    pub fn probe(&mut self, key: u64) -> Option<Entry> {
        self.probes += 1;
        let e = self.entries[self.index(key)];
        if e.key == key && e.flag != FLAG_NONE {
            self.hits += 1;
            Some(e)
        } else {
            None
        }
    }

    pub fn store(&mut self, key: u64, mv: Move, score: i32, depth: i8, flag: u8) {
        let idx = self.index(key);
        let entry = &mut self.entries[idx];
        // Always overwrite: depth ties go to the newer entry, which is the one
        // from the search we are actually in.
        entry.key = key;
        entry.mv = mv.0;
        entry.score = score;
        entry.depth = depth;
        entry.flag = flag;
    }

    pub fn clear(&mut self) {
        for e in self.entries.iter_mut() {
            *e = Entry::default();
        }
        self.probes = 0;
        self.hits = 0;
    }
}
