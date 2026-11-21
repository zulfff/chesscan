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

    /// Drop anything already queued on the reader thread.
    ///
    /// A stopped search still emits its final `info` lines and one `bestmove`.
    /// Those describe the *old* position; if they survive into the next
    /// `analyze` they are read as the new position's analysis, or the stale
    /// `bestmove` ends the new search before it has emitted a single line.
    /// Analysis of a position that was never searched is the worst kind of
    /// wrong: it looks confident.
    fn drain(&mut self) {
        while self.lines.try_recv().is_ok() {}
    }

    /// Abort an in-flight search and consume its tail through `bestmove`, so the
    /// channel is clean before the next position is sent.
    fn abort(&mut self) {
        let _ = self.send("stop");
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match self.lines.recv_timeout(left) {
                Ok(l) if l.starts_with("bestmove") => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
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
        // Never let a previous search's tail masquerade as this one's output.
        self.drain();
        self.send(&format!("setoption name MultiPV value {}", multipv.max(1)))?;
        self.send("ucinewgame")?;
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;

        let mut found: Vec<PvLine> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);

        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                self.abort();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_info_reads_multipv_and_pv() {
        let pv = parse_info(
            "info depth 18 seldepth 24 multipv 2 score cp -34 nodes 1200000 pv d2d4 d7d5 c2c4",
        )
        .expect("line should parse");
        assert_eq!(pv.depth, 18);
        assert_eq!(pv.multipv, 2);
        assert_eq!(pv.score, Score::Cp(-34));
        assert_eq!(pv.pv, vec!["d2d4", "d7d5", "c2c4"]);
    }

    #[test]
    fn parse_info_ignores_lines_without_a_score_or_pv() {
        assert!(parse_info("info depth 10 currmove e2e4").is_none());
        assert!(parse_info("info depth 10 score cp 20").is_none());
        assert!(parse_info("info depth 10 score cp nope pv e2e4").is_none());
        assert!(parse_info("bestmove e2e4").is_none());
    }

    #[test]
    fn mate_scores_map_to_certain_wins() {
        assert_eq!(win_probability(Score::Mate(3), true), 1.0);
        assert_eq!(win_probability(Score::Mate(-3), true), 0.0);
        assert_eq!(win_probability(Score::Mate(3), false), 0.0);
        assert_eq!(win_probability(Score::Mate(-3), false), 1.0);
    }

    #[cfg(unix)]
    #[test]
    fn stale_tail_cannot_leak_into_the_next_search() {
        use std::os::unix::fs::PermissionsExt;

        // A UCI engine that answers correctly, then deliberately emits a deeper
        // `info` line *after* bestmove. That is the tail a stopped search leaves
        // behind. Without the drain, the next analyze() adopts it as its own.
        let dir = std::env::temp_dir().join(format!("chesscan-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tailfish.sh");
        std::fs::write(
            &path,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    uci) echo uciok ;;
    isready) echo readyok ;;
    go*)
      echo "info depth 10 multipv 1 score cp 20 nodes 1 pv e2e4 e7e5"
      echo "bestmove e2e4"
      echo "info depth 99 multipv 1 score cp 9999 nodes 1 pv a1a1"
      ;;
    quit) exit 0 ;;
  esac
done
"#,
        )
        .unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();

        let mut eng = Engine::spawn(path.to_str().unwrap()).unwrap();
        let first = eng.analyze("4k3/8/8/8/8/8/8/4K3 w - - 0 1", 10, 1).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].depth, 10, "first search must be its own lines");

        // Let the reader thread queue the leaked tail before asking again.
        std::thread::sleep(Duration::from_millis(150));

        let second = eng.analyze("4k3/8/8/8/8/8/8/4K3 w - - 0 1", 10, 1).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(
            second[0].depth, 10,
            "a depth-99 line from the previous search leaked into the new one"
        );
        assert_eq!(second[0].score, Score::Cp(20));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
