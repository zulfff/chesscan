//! Stockfish over UCI, as a child process.
//!
//! Deliberately *not* an FFI binding. A subprocess is restartable, cannot corrupt
//! our address space with a bad search, and lets LO swap in any UCI engine
//! (Stockfish, Lc0, Berserk) by changing one path. The cost is text parsing,
//! which is trivial and, unlike link-time ABI games, debuggable at 3am.

use anyhow::{anyhow, bail, Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Score {
    Cp(i32),
    Mate(i32),
}

#[derive(Debug, Clone)]
pub struct PvLine {
    pub multipv: u32,
    pub depth: u32,
    pub score: Score,
    pub pv: Vec<String>,
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl Engine {
    pub fn spawn(path: &str) -> Result<Self> {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawning engine '{path}' (is it on PATH?)"))?;

        let stdin = child.stdin.take().context("engine stdin")?;
        let stdout = child.stdout.take().context("engine stdout")?;

        // Blocking reader on its own thread so a hung search can never freeze us.
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut e = Engine {
            child,
            stdin,
            lines: rx,
        };
        e.send("uci")?;
        e.wait_for("uciok", Duration::from_secs(10))?;
        e.send("setoption name Threads value 2")?;
        e.send("setoption name Hash value 128")?;
        e.send("isready")?;
        e.wait_for("readyok", Duration::from_secs(10))?;
        Ok(e)
    }

    fn send(&mut self, cmd: &str) -> Result<()> {
        writeln!(self.stdin, "{cmd}").context("writing to engine")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn wait_for(&mut self, token: &str, timeout: Duration) -> Result<()> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                bail!("engine did not answer '{token}' within {timeout:?}");
            }
            match self.lines.recv_timeout(left) {
                Ok(l) if l.trim() == token => return Ok(()),
                Ok(_) => continue,
                Err(_) => bail!("engine closed the pipe while waiting for '{token}'"),
            }
        }
    }

    /// Run one search and return all MultiPV lines, best first.
    pub fn analyze(&mut self, fen: &str, depth: u32, multipv: u32) -> Result<Vec<PvLine>> {
        self.send(&format!("setoption name MultiPV value {}", multipv.max(1)))?;
        self.send("ucinewgame")?;
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;

        let mut found: Vec<PvLine> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);

        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                let _ = self.send("stop");
                bail!("search exceeded 30s at depth {depth}");
            }
            let line = self
                .lines
                .recv_timeout(left)
                .map_err(|_| anyhow!("engine timeout"))?;

            if line.starts_with("bestmove") {
                break;
            }
            if let Some(pv) = parse_info(&line) {
                // Keep the deepest entry per multipv slot.
                match found.iter_mut().find(|x| x.multipv == pv.multipv) {
                    Some(slot) if slot.depth <= pv.depth => *slot = pv,
                    Some(_) => {}
                    None => found.push(pv),
                }
            }
        }

        if found.is_empty() {
            bail!("engine produced no pv lines");
        }
        found.sort_by_key(|p| p.multipv);
        Ok(found)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.wait();
    }
}

fn parse_info(line: &str) -> Option<PvLine> {
    if !line.starts_with("info ") || !line.contains(" pv ") {
        return None;
    }
    let toks: Vec<&str> = line.split_whitespace().collect();
    let mut depth = 0;
    let mut multipv = 1;
    let mut score = None;
    let mut pv = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "depth" => {
                depth = toks.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "multipv" => {
                multipv = toks.get(i + 1)?.parse().ok()?;
                i += 2;
            }
            "score" => {
                let kind = *toks.get(i + 1)?;
                let val: i32 = toks.get(i + 2)?.parse().ok()?;
                score = Some(match kind {
                    "cp" => Score::Cp(val),
                    "mate" => Score::Mate(val),
                    _ => return None,
                });
                i += 3;
            }
            "pv" => {
                pv = toks[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }
    Some(PvLine {
        multipv,
        depth,
        score: score?,
        pv,
    })
}

/// Centipawn score from the side-to-move's perspective flipped to white's, which
/// is the convention humans and every chess UI use.
pub fn white_cp(score: Score, white_to_move: bool) -> Option<i32> {
    let v = match score {
        Score::Cp(cp) => cp,
        Score::Mate(_) => return None,
    };
    Some(if white_to_move { v } else { -v })
}

/// Lichess' win-probability curve. Fitted on real games, so it is honest about
/// the fact that +2 does not mean "won" and +0.3 is basically a coin flip.
pub fn win_probability(score: Score, white_to_move: bool) -> f64 {
    match score {
        Score::Mate(m) => {
            let white_mates = if white_to_move { m > 0 } else { m < 0 };
            if white_mates {
                1.0
            } else {
                0.0
            }
        }
        Score::Cp(cp) => {
            let w = if white_to_move {
                cp as f64
            } else {
                -(cp as f64)
            };
            1.0 / (1.0 + (-0.00368208 * w).exp())
        }
    }
}
