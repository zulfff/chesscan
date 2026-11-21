// Human-like move selection over a MultiPV search.
//
// Stockfish tells you the truth. Humans tell you what a depth-6 look at the
// board says, filtered through a mood. This module sits between the two:
// it takes the engine's ranked lines and picks one the way a person with a
// rating would, not the way a 3500 Elo search would.
//
// Three mechanisms, all cheap:
//
//   1. Temperature. Each candidate carries a win-probability loss against the
//      best move. Weights are exp(-loss / T), with T falling as rating rises.
//      Low rated players genuinely consider moves that lose a fifth of a pawn
//      of expectation; engines never do.
//
//   2. Depth disagreement. Humans see a move look good at first glance and
//      only later notice it loses. The engine emits the same MultiPV slot at
//      increasing depth, so we keep the first and last evaluation for each
//      move. Shallow-good/deep-bad is a blunder a human actually makes.
//      Shallow-bad/deep-good is a brilliancy, and we sometimes play it.
//
//   3. Style. A small bias toward checks and captures, scaled by aggression.
//      It changes which equivalent move gets picked, not whether a good move
//      gets picked.

import { winProbability } from "./engine.js";

/** Rating -> behaviour. elo is the knob; the rest are personality. */
export const SKILL = {
  casual: { elo: 850, aggression: 0.45, brilliancy: 0.10, mistake: 0.14 },
  club: { elo: 1250, aggression: 0.55, brilliancy: 0.09, mistake: 0.11 },
  solid: { elo: 1750, aggression: 0.4, brilliancy: 0.02, mistake: 0, ceiling: 60 },
  strongClub: { elo: 1650, aggression: 0.5, brilliancy: 0.08, mistake: 0.08 },
  expert: { elo: 2000, aggression: 0.55, brilliancy: 0.07, mistake: 0.05 },
  master: { elo: 2300, aggression: 0.5, brilliancy: 0.06, mistake: 0.03 },
};

/**
 * A profile for a rating: same knobs as SKILL, interpolated from the elo.
 * Used by auto mode, where there is no fixed preset to copy.
 */
export function profileFor(elo, rng = Math.random) {
  const t = Math.max(0, Math.min(1, (elo - 800) / 1600));
  return {
    elo: Math.round(elo),
    aggression: 0.35 + 0.4 * rng(),
    brilliancy: 0.1 + (0.05 - 0.1) * t,
    mistake: 0.15 + (0.02 - 0.15) * t,
  };
}

function gauss(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/**
 * Form over a session: a player is not a constant rating.
 *
 * A day starts somewhere around the base (good day, off day), drifts while
 * mean-reverting, and occasionally tilts for a few moves in either direction.
 * Per move there is noise on top. The point is a partner whose strength moves
 * the way a person's does across an evening, not a random number generator.
 */
export class Form {
  constructor({ base = 1500, spread = 80, rng = Math.random } = {}) {
    this.base = base;
    this.rng = rng;
    this.mood = gauss(rng) * spread;
    this.tilt = 0;
    this.tiltLeft = 0;
    this.elo = Math.round(base + this.mood);
  }

  next() {
    this.mood *= 0.97;
    this.mood += gauss(this.rng) * 12;

    if (this.tiltLeft > 0) {
      this.tiltLeft--;
      if (this.tiltLeft === 0) this.tilt = 0;
    } else if (this.rng() < 0.04) {
      const sign = this.rng() < 0.5 ? -1 : 1;
      this.tilt = sign * (110 + this.rng() * 160);
      this.tiltLeft = 3 + Math.floor(this.rng() * 5);
    }

    const raw = this.base + this.mood + this.tilt + gauss(this.rng) * 55;
    this.elo = Math.round(Math.max(600, Math.min(2500, raw)));
    return profileFor(this.elo, this.rng);
  }
}

/**
 * Search temperature for a rating. Calibrated so a 1400 sits near 0.07 win
 * probability of slack and a 2300 is effectively sharp, but not exact.
 */
export function temperature(elo) {
  const t = 0.42 * Math.pow(10, -(elo - 700) / 900);
  return Math.max(t, 0.004);
}

/**
 * Largest centipawn loss a player of this rating will hand over on purpose.
 * This is the slop guard: it is deliberately tight, so the "human" part of a
 * move comes from choosing between good candidates, not from hanging pieces.
 */
export function cpCeiling(elo) {
  const t = 180 - (120 * (elo - 800)) / 1600;
  return Math.max(60, Math.min(180, t));
}

const MATE_CP = 10000;

/** Side-to-move centipawns for one MultiPV line, mates scored at the edge. */
function lineCp(line, turn) {
  const s = line.score;
  if (!s) return 0;
  const v =
    s.type === "mate" ? (s.value >= 0 ? MATE_CP - s.value : -MATE_CP - s.value) : s.value;
  return turn === "w" ? v : -v;
}

/** Side-to-move win probability for one MultiPV line. */
function lineWin(line, turn) {
  return winProbability(line.score, turn);
}

/** UCI move from a line, or null if the PV is truncated. */
function lineMove(line) {
  return line.pv && line.pv.length ? line.pv[0] : null;
}

function isCheckLike(uci) {
  // Not knowable without a board. Callers that have one can pre-tag moves.
  return false;
}

export class Humanizer {
  /**
   * @param {object} opts
   * @param {number} [opts.elo=1400]
   * @param {number} [opts.aggression=0.5]   0..1, bias toward forcing moves
   * @param {number} [opts.brilliancy=0.08]  chance of playing a deep-only find
   * @param {number} [opts.mistake=0.10]     chance per move of a plausible error
   * @param {number} [opts.ceiling]          override the rating's centipawn ceiling
   * @param {() => number} [opts.rng]        injectable for tests
   */
  constructor(opts = {}) {
    this.elo = opts.elo ?? 1400;
    this.aggression = opts.aggression ?? 0.5;
    this.brilliancy = opts.brilliancy ?? 0.08;
    this.mistake = opts.mistake ?? 0.10;
    this.ceiling = opts.ceiling ?? null;
    this.rng = opts.rng ?? Math.random;
    // Depths 1-2 are noise, not a glance. Only evaluations in this band count
    // as "what the move looked like before you thought about it".
    this.glanceDepth = opts.glanceDepth ?? 6;
    this.glanceFloor = opts.glanceFloor ?? 2;
    this.reset();
  }

  /** Call once per position. Forget the previous one's evaluations. */
  reset() {
    this.seen = new Map(); // uci -> { glance, deep, depth }
    this.movesSeen = 0;
  }

  /**
   * Feed every info update. The first evaluation of a move is its "first
   * glance", the last one is what you get after thinking about it.
   */
  observe(lines, turn) {
    if (!lines) return;
    for (const line of lines) {
      const uci = lineMove(line);
      if (!uci) continue;
      const win = lineWin(line, turn);
      const depth = line.depth || 0;
      const inBand = depth >= this.glanceFloor && depth <= this.glanceDepth;
      const prev = this.seen.get(uci);
      if (!prev) {
        this.seen.set(uci, { glance: inBand ? win : null, deep: win, depth });
      } else {
        if (prev.glance === null && inBand) prev.glance = win;
        if (depth >= prev.depth) {
          prev.deep = win;
          prev.depth = depth;
        }
      }
    }
    this.movesSeen = this.seen.size;
  }

  /** The ceiling in force: a profile override, else the rating curve. */
  slopCeiling() {
    return this.ceiling ?? cpCeiling(this.elo);
  }

  /**
   * Pick a move.
   * @returns {{uci:string, reason:string, loss:number, win:number, spread:number}}
   */
  choose(lines, turn) {
    const cands = (lines || [])
      .map(line => {
        const uci = lineMove(line);
        if (!uci) return null;
        const win = lineWin(line, turn);
        const trace = this.seen.get(uci);
        return {
          uci,
          win,
          cp: lineCp(line, turn),
          depth: line.depth,
          glance: trace && trace.glance !== null ? trace.glance : win,
          // positive = the move improved as it was thought about
          surprise: trace && trace.glance !== null ? trace.deep - trace.glance : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.win - a.win);

    if (!cands.length) throw new Error("humanize: no candidate moves");

    // Forced or trivially clear: don't invent drama where there is none.
    const best = cands[0];
    if (cands.length === 1) return this.package(best, "forced", best);

    const glanceOrder = [...cands].sort((a, b) => b.glance - a.glance);
    const glanceBest = glanceOrder[0];
    const spread = best.win - cands[cands.length - 1].win;

    // A move that looked worse than the obvious one, then turned out best.
    // That is what a brilliancy looks like from the inside.
    if (best !== glanceBest && best.surprise > 0.08 && best.win - glanceBest.win > 0.02) {
      const pull = Math.min(1, best.surprise / 0.2) * Math.min(1, 0.4 + spread * 3);
      if (this.rng() < this.brilliancy * pull) {
        return this.package(best, "brilliant", best);
      }
    }

    // A genuine error: something that looked fine at a glance and isn't.
    if (this.rng() < this.mistake) {
      const ceiling = this.slopCeiling();
      const plausible = glanceOrder.filter(c => {
        const loss = best.cp - c.cp;
        // Visibly plausible at first glance, wrong on reflection, and never
        // past the slop ceiling.
        return c !== best && c.surprise < -0.04 && loss >= 30 && loss <= ceiling;
      });
      if (plausible.length) {
        const pick = plausible[Math.floor(this.rng() * plausible.length)];
        return this.package(pick, "mistake", best);
      }
    }

    return this.package(this.weighted(cands, best), "temperature", best);
  }

  /** Softmax over win-probability loss, with a hard centipawn ceiling on slop. */
  weighted(cands, best) {
    const t = temperature(this.elo);
    const ceiling = this.slopCeiling();
    const weights = [];
    for (const c of cands) {
      if (best.cp - c.cp > ceiling) {
        weights.push(0);
        continue;
      }
      const style = 1 + this.aggression * 0.15 * this.styleBonus(c.uci);
      weights.push(Math.exp(-(best.win - c.win) / t) * style);
    }

    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return cands[0];

    let roll = this.rng() * total;
    for (let i = 0; i < cands.length; i++) {
      roll -= weights[i];
      if (roll <= 0 && weights[i] > 0) return cands[i];
    }
    return cands[0];
  }

  /**
   * Crude forcing-move bias from the UCI string alone. If the caller has a
   * board it can set `move.tags` and this becomes accurate; otherwise it is
   * a nudge, and a nudge is all it should be.
   */
  styleBonus(uci) {
    const target = uci.slice(2, 4);
    // Promotion to anything but queen, or a check-like capture on the back rank.
    if (target[1] === "1" || target[1] === "8") return 0.5;
    if (isCheckLike(uci)) return 1;
    return 0;
  }

  package(cand, reason, best) {
    return {
      uci: cand.uci,
      reason,
      loss: best.win - cand.win,
      cpLoss: best.cp - cand.cp,
      win: cand.win,
      glanceWin: cand.glance,
      depth: cand.depth,
      spread: best.win - cand.win,
    };
  }
}

/**
 * How long a human spends on this move, in milliseconds.
 *
 * Not a detection model — just the shape of human thinking: forced moves are
 * instant, sharp positions take noticeably longer, and the same position is
 * never two the same. Log-normal around a base, hard-clamped to a range a
 * person can actually sit through.
 */
export function thinkTime({ elo = 1400, branching = 30, instability = 0, forced = false, rng = Math.random }) {
  if (forced) return 200 + rng() * 300;

  // Stronger players burn more clock; chaos costs more than branching.
  const base = 900 + 2200 * instability + 18 * Math.max(0, branching - 20);
  const skill = 1 + (elo - 1200) / 2400;
  const gauss = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const ms = base * skill * Math.exp(0.45 * gauss);

  return Math.round(Math.min(22000, Math.max(350, ms)));
}