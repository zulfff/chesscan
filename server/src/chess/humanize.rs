//! The humanizer.
//!
//! A search returns the truth; a person returns a move that is *plausible*.
//! This module picks between the engine's ranked ideas the way a player of a
//! given rating would: softmax over win-probability loss, a hard centipawn
//! ceiling so it never hangs a piece, occasional slips and occasional
//! brilliancies, and a think time that follows the shape of human attention.
//!
//! It is deliberately deterministic for a given `(position, seed)`, because a
//! client that re-analyses the same board must not get a different answer for
//! no reason.

use super::board::Board;
use super::types::*;

#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub elo: i32,
    pub aggression: f64,
    pub brilliancy: f64,
    pub mistake: f64,
    pub ceiling: Option<i32>,
}

impl Default for Profile {
    fn default() -> Self {
        Profile {
            elo: 1400,
            aggression: 0.5,
            brilliancy: 0.08,
            mistake: 0.10,
            ceiling: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub mv: Move,
    pub cp: i32,
    /// The evaluation at the "first glance" depth, when the caller has one.
    pub shallow_cp: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct Pick {
    pub mv: Move,
    pub reason: String,
    pub cp_loss: i32,
    pub win: f64,
    pub glance_win: f64,
    pub think_ms: u64,
}

pub fn temperature(elo: i32) -> f64 {
    let t = 0.42 * 10f64.powf(-((elo - 700) as f64) / 900.0);
    t.max(0.004)
}

/// Largest centipawn loss a player of this rating will hand over on purpose.
pub fn cp_ceiling(elo: i32) -> i32 {
    let t = 180 - (120 * (elo - 800)) / 1600;
    t.clamp(60, 180)
}

/// Lichess' win-probability curve, from the side-to-move's point of view.
pub fn win_probability(cp: i32) -> f64 {
    1.0 / (1.0 + (-0.00368208 * cp as f64).exp())
}

fn win_of(c: &Candidate) -> f64 {
    win_probability(c.cp)
}

fn glance_win_of(c: &Candidate) -> f64 {
    win_probability(c.shallow_cp.unwrap_or(c.cp))
}

/// A small deterministic RNG, so a re-analysis of the same position agrees.
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn seed_from(s: &str) -> Rng {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in s.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        Rng { state: h }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gauss(&mut self) -> f64 {
        let u = 1.0 - self.next_f64();
        let v = self.next_f64();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// Form over a session: the rating wanders the way a person's does across an
/// evening rather than being re-rolled every move.
pub struct Form {
    base: i32,
    mood: f64,
    tilt: i32,
    tilt_left: u32,
    elo: i32,
    rng: Rng,
}

impl Form {
    pub fn new(base: i32, seed: &str) -> Form {
        let mut rng = Rng::seed_from(seed);
        let mood = rng.gauss() * 80.0;
        Form {
            base,
            mood,
            tilt: 0,
            tilt_left: 0,
            elo: (base as f64 + mood).round() as i32,
            rng,
        }
    }

    pub fn next(&mut self) -> Profile {
        self.mood *= 0.97;
        self.mood += self.rng.gauss() * 12.0;

        if self.tilt_left > 0 {
            self.tilt_left -= 1;
            if self.tilt_left == 0 {
                self.tilt = 0;
            }
        } else if self.rng.next_f64() < 0.04 {
            let sign = if self.rng.next_f64() < 0.5 { -1 } else { 1 };
            self.tilt = sign * (110 + (self.rng.next_f64() * 160.0) as i32);
            self.tilt_left = 3 + (self.rng.next_f64() * 5.0) as u32;
        }

        let raw = self.base as f64 + self.mood + self.tilt as f64 + self.rng.gauss() * 55.0;
        self.elo = (raw.round() as i32).clamp(600, 2500);
        profile_for(self.elo, &mut self.rng)
    }
}

/// Interpolate a personality from a rating, matching the extension's presets.
pub fn profile_for(elo: i32, rng: &mut Rng) -> Profile {
    let t = ((elo - 800) as f64 / 1600.0).clamp(0.0, 1.0);
    Profile {
        elo,
        aggression: 0.35 + 0.4 * rng.next_f64(),
        brilliancy: 0.10 + (0.05 - 0.10) * t,
        mistake: 0.15 + (0.02 - 0.15) * t,
        ceiling: None,
    }
}

/// How long a human spends on this move, in milliseconds.
pub fn think_time(elo: i32, branching: u32, instability: f64, forced: bool, rng: &mut Rng) -> u64 {
    if forced {
        return (200.0 + rng.next_f64() * 300.0) as u64;
    }
    let base = 900.0 + 2200.0 * instability + 18.0 * (branching.saturating_sub(20)) as f64;
    let skill = 1.0 + (elo - 1200) as f64 / 2400.0;
    let ms = base * skill * (0.45 * rng.gauss()).exp();
    ms.round().clamp(350.0, 22000.0) as u64
}

fn style_bonus(uci: &str) -> f64 {
    let bytes = uci.as_bytes();
    if bytes.len() < 4 {
        return 0.0;
    }
    let rank = bytes[3];
    if rank == b'1' || rank == b'8' {
        0.5
    } else {
        0.0
    }
}

/// Pick a move. `candidates` must be non-empty. `rng` is injected so the
/// server can be deterministic per position when it wants to be.
pub fn choose(candidates: &[Candidate], profile: &Profile, rng: &mut Rng) -> Option<Pick> {
    if candidates.is_empty() {
        return None;
    }

    let mut cands: Vec<Candidate> = candidates.to_vec();
    cands.sort_by(|a, b| win_of(b).partial_cmp(&win_of(a)).unwrap());

    if cands.len() == 1 {
        let c = cands[0].clone();
        return Some(Pick {
            mv: c.mv,
            reason: "forced".into(),
            cp_loss: 0,
            win: win_of(&c),
            glance_win: glance_win_of(&c),
            think_ms: think_time(profile.elo, 1, 0.0, true, rng),
        });
    }

    let best = cands[0].clone();
    let glance_order = {
        let mut v = cands.clone();
        v.sort_by(|a, b| glance_win_of(b).partial_cmp(&glance_win_of(a)).unwrap());
        v
    };
    let glance_best = glance_order[0].clone();
    let spread = win_of(&best) - win_of(&cands[cands.len() - 1]);

    // A brilliancy: it looked worse, then it turned out best.
    if best.mv != glance_best.mv {
        let surprise = win_of(&best) - glance_win_of(&best);
        if surprise > 0.08 && win_of(&best) - win_of(&glance_best) > 0.02 {
            let pull = (surprise / 0.2).min(1.0) * (0.4 + spread * 3.0).min(1.0);
            if rng.next_f64() < profile.brilliancy * pull {
                return Some(package(&best, "brilliant", &best, profile, rng, cands.len()));
            }
        }
    }

    // A slip: it looked fine at a glance and isn't, but never past the ceiling.
    if rng.next_f64() < profile.mistake {
        let ceiling = profile.ceiling.unwrap_or_else(|| cp_ceiling(profile.elo));
        let plausible: Vec<Candidate> = glance_order
            .iter()
            .filter(|c| {
                if c.mv == best.mv {
                    return false;
                }
                let surprise = win_of(c) - glance_win_of(c);
                let loss = best.cp - c.cp;
                surprise < -0.04 && loss >= 30 && loss <= ceiling
            })
            .cloned()
            .collect();
        if !plausible.is_empty() {
            let pick = plausible[(rng.next_f64() * plausible.len() as f64) as usize].clone();
            return Some(package(&pick, "mistake", &best, profile, rng, cands.len()));
        }
    }

    let pick = weighted(&cands, &best, profile, rng);
    Some(package(&pick, "temperature", &best, profile, rng, cands.len()))
}

fn weighted(cands: &[Candidate], best: &Candidate, profile: &Profile, rng: &mut Rng) -> Candidate {
    let t = temperature(profile.elo);
    let ceiling = profile.ceiling.unwrap_or_else(|| cp_ceiling(profile.elo));
    let mut weights = Vec::with_capacity(cands.len());
    for c in cands {
        if best.cp - c.cp > ceiling {
            weights.push(0.0);
            continue;
        }
        let style = 1.0 + profile.aggression * 0.15 * style_bonus(&c.mv.uci());
        weights.push((-((win_of(best) - win_of(c)) / t)).exp() * style);
    }
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return best.clone();
    }
    let mut roll = rng.next_f64() * total;
    for (i, c) in cands.iter().enumerate() {
        roll -= weights[i];
        if roll <= 0.0 && weights[i] > 0.0 {
            return c.clone();
        }
    }
    best.clone()
}

fn package(c: &Candidate, reason: &str, best: &Candidate, profile: &Profile, rng: &mut Rng, branching: usize) -> Pick {
    Pick {
        mv: c.mv,
        reason: reason.into(),
        cp_loss: best.cp - c.cp,
        win: win_of(c),
        glance_win: glance_win_of(c),
        think_ms: think_time(profile.elo, branching as u32, 0.0, false, rng),
    }
}

/// Build a candidate list from a search result, attaching the shallow scores.
pub fn candidates_from_lines(lines: &[super::search::RootLine]) -> Vec<Candidate> {
    lines
        .iter()
        .map(|l| Candidate {
            mv: l.mv,
            cp: l.score,
            shallow_cp: l.shallow,
        })
        .collect()
}

/// Count the legal moves, for the think-time branching factor.
pub fn branching_factor(board: &Board) -> usize {
    super::movegen::legal_moves(board).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cands(spec: &[(&str, i32, Option<i32>)]) -> Vec<Candidate> {
        spec.iter()
            .map(|(u, cp, shallow)| Candidate {
                mv: Move::parse_uci(u).unwrap(),
                cp: *cp,
                shallow_cp: *shallow,
            })
            .collect()
    }

    #[test]
    fn a_single_candidate_is_forced() {
        let cs = cands(&[("e2e4", 30, None)]);
        let mut rng = Rng::seed_from("x");
        let p = choose(&cs, &Profile::default(), &mut rng).unwrap();
        assert_eq!(p.reason, "forced");
        assert_eq!(p.mv.uci(), "e2e4");
    }

    #[test]
    fn a_much_worse_move_is_never_chosen_past_the_ceiling() {
        let cs = cands(&[("e2e4", 30, None), ("a2a3", -900, None)]);
        let mut rng = Rng::seed_from("y");
        for _ in 0..200 {
            let p = choose(&cs, &Profile::default(), &mut rng).unwrap();
            assert_eq!(p.mv.uci(), "e2e4", "a lost position must not be 'humanized'");
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_pick() {
        let cs = cands(&[("e2e4", 30, Some(40)), ("d2d4", 20, Some(10)), ("g1f3", 5, None)]);
        let profile = Profile { elo: 1200, ..Profile::default() };
        let a = choose(&cs, &profile, &mut Rng::seed_from("pos")).unwrap();
        let b = choose(&cs, &profile, &mut Rng::seed_from("pos")).unwrap();
        assert_eq!(a.mv.uci(), b.mv.uci());
        assert_eq!(a.reason, b.reason);
    }

    #[test]
    fn a_strong_player_sticks_to_the_best_move() {
        let cs = cands(&[("e2e4", 30, None), ("d2d4", 0, None), ("g1f3", -200, None)]);
        let profile = Profile { elo: 2500, mistake: 0.0, brilliancy: 0.0, ..Profile::default() };
        let mut rng = Rng::seed_from("z");
        let p = choose(&cs, &profile, &mut rng).unwrap();
        assert_eq!(p.mv.uci(), "e2e4");
    }

    #[test]
    fn think_time_is_bounded() {
        let mut rng = Rng::seed_from("t");
        for _ in 0..500 {
            let ms = think_time(1500, 30, 0.5, false, &mut rng);
            assert!(ms >= 350 && ms <= 22000, "think time {ms} out of range");
        }
        assert!(think_time(1500, 1, 0.0, true, &mut Rng::seed_from("f")) <= 500);
    }
}
