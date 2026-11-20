//! chesscan - live screen chess scanner.
//!
//! Pipeline: capture -> crop -> 64 descriptors -> classify -> FEN -> UCI engine
//! -> HUD. Each stage is a module you can test on its own, which matters because
//! board reading is the only part that ever needs babysitting.

use anyhow::{bail, Context, Result};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use chesscan::read::{print_board, read_board};
use chesscan::{capture, classify, config, engine, fen, overlay};

pub struct Args {
    pub file: Option<PathBuf>,
    pub monitor: Option<usize>,
    pub calibrate: bool,
    pub snapshot: bool,
    pub rect: Option<String>,
    pub engine: Option<String>,
    pub depth: Option<u32>,
    pub white_to_move: Option<bool>,
    pub no_hud: bool,
    pub interval_ms: u64,
    pub classes: usize,
    pub labels: Option<String>,
    pub auto: bool,
    pub detect: bool,
    pub flip: bool,
    pub doctor: bool,
    pub dump_squares: bool,
}

fn parse_args() -> Result<Args> {
    let mut a = Args {
        file: None,
        monitor: None,
        calibrate: false,
        snapshot: false,
        rect: None,
        engine: None,
        depth: None,
        white_to_move: None,
        no_hud: false,
        interval_ms: 900,
        classes: 13,
        labels: None,
        auto: false,
        detect: false,
        flip: false,
        doctor: false,
        dump_squares: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--file" | "-f" => {
                a.file = Some(PathBuf::from(it.next().context("--file needs a path")?))
            }
            "--monitor" | "-m" => {
                a.monitor = Some(it.next().context("--monitor needs an index")?.parse()?)
            }
            "--calibrate" => a.calibrate = true,
            "--snapshot" => a.snapshot = true,
            "--rect" => a.rect = Some(it.next().context("--rect needs x,y,w,h")?),
            "--engine" | "-e" => a.engine = Some(it.next().context("--engine needs a path")?),
            "--depth" | "-d" => {
                a.depth = Some(it.next().context("--depth needs a number")?.parse()?)
            }
            "--black" => a.white_to_move = Some(false),
            "--white" => a.white_to_move = Some(true),
            "--no-hud" => a.no_hud = true,
            "--interval" => a.interval_ms = it.next().context("--interval needs ms")?.parse()?,
            "--classes" => a.classes = it.next().context("--classes needs a count")?.parse()?,
            "--labels" => a.labels = Some(it.next().context("--labels needs a comma list")?),
            "--auto" => a.auto = true,
            "--detect" => a.detect = true,
            "--doctor" => a.doctor = true,
            "--dump-squares" => a.dump_squares = true,
            "--flip" => a.flip = true,
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            other => bail!("unknown argument '{other}' (try --help)"),
        }
    }
    Ok(a)
}

fn print_help() {
    println!(
        "chesscan - live screen chess scanner

USAGE:
  chesscan --auto --calibrate             # one-time: find board, learn theme
  chesscan                               # live scan + HUD (auto-detect on start)
  chesscan --detect [--file shot.png]     # print the detected board rect
  chesscan --snapshot [--file shot.png]   # print FEN, no engine

FLAGS:
  --auto           re-detect the board on start and when reads start failing
  --detect         locate the board, save its rect, and exit
  --doctor         report session, monitors, capture and detection health
  --rect x,y,w,h   override the board pixel rect manually
  --flip           board is drawn with black at the bottom
  --calibrate      cluster squares and label piece classes
  --snapshot       dump the detected board + FEN and exit
  --file <path>    use a saved screenshot instead of the live screen
  --monitor <n>    monitor index for live capture (default 0)
  --engine <path>  UCI engine binary (default: stockfish)
  --depth <n>      search depth (default: 18)
  --interval <ms>  scan cadence (default: 900)
  --white/--black  which side is to move at start
  --classes <n>    clusters to learn during calibration (default: 13)
  --no-hud         terminal output only"
    );
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let cfg_path = config::resolve_path();
    let mut cfg = config::Config::load_or_default(&cfg_path)?;

    if let Some(r) = &args.rect {
        cfg.board = parse_rect(r)?;
        cfg.save(&cfg_path)?;
        println!(
            "board rect saved: {}x{} at {},{}",
            cfg.board.w, cfg.board.h, cfg.board.x, cfg.board.y
        );
    }
    if let Some(e) = &args.engine {
        cfg.engine_path = e.clone();
    }
    if let Some(d) = args.depth {
        cfg.depth = d;
    }
    if args.flip {
        cfg.white_bottom = false;
    }

    let source = capture::Source::new(args.file.clone(), args.monitor);

    if args.doctor {
        return doctor(&cfg, &source);
    }

    if args.detect {
        return detect_board(&mut cfg, &cfg_path, &source);
    }
    if args.dump_squares {
        return dump_squares(&cfg, &source);
    }
    if args.auto {
        if let Err(e) = detect_board(&mut cfg, &cfg_path, &source) {
            eprintln!("auto-detect failed ({e}); using saved rect");
        }
    }

    if args.calibrate {
        return calibrate(&args, &mut cfg, &cfg_path, &source);
    }
    if args.snapshot {
        return snapshot(&args, &cfg, &source);
    }
    if cfg.prototypes.is_empty() {
        bail!("no prototypes learned yet; run `chesscan --auto --calibrate` first");
    }
    run(&args, &mut cfg, &cfg_path, &source)
}

/// `--doctor`: print everything needed to diagnose a capture or detection
/// problem in one paste-able block.
fn doctor(cfg: &config::Config, source: &capture::Source) -> Result<()> {
    println!("chesscan {}", env!("CARGO_PKG_VERSION"));
    println!("config:     {}", config::resolve_path().display());
    println!("prototypes: {}", cfg.prototypes.len());
    println!("board rect: {}x{} at {},{}", cfg.board.w, cfg.board.h, cfg.board.x, cfg.board.y);
    println!("wayland:    {}", capture::is_wayland());
    println!("session:");
    print!("{}", capture::session_report());

    println!("capture:");
    match source.grab() {
        Ok(f) => {
            println!("  ok: {}x{} frame", f.width(), f.height());
            println!("detection:");
            match chesscan::read::detect_board(&f, cfg) {
                Ok(r) => println!("  found: {}x{} at {},{}", r.w, r.h, r.x, r.y),
                Err(e) => println!("  not found: {e}"),
            }
            if !cfg.prototypes.is_empty() {
                match capture::crop(&f, &cfg.board).and_then(|b| read_board(&b, cfg)) {
                    Ok(b) => {
                        println!("read:");
                        print_board(&b);
                    }
                    Err(e) => println!("read: {e}"),
                }
            }
        }
        Err(e) => println!("  FAILED: {e:#}"),
    }
    Ok(())
}

/// `--dump-squares`: one line per square so a misread can be traced to pixels
/// instead of guessed at.
fn dump_squares(cfg: &config::Config, source: &capture::Source) -> Result<()> {
    let frame = source.grab()?;
    let board_img = capture::crop(&frame, &cfg.board)?;
    println!("crop: {}x{}", board_img.width(), board_img.height());
    let patches = capture::square_patches(&board_img, cfg.white_bottom);
    for ((file, rank), patch) in patches {
        let d = classify::descriptor(&patch);
        let c = classify::ink_rgb(&d);
        let (piece, _, note) = if cfg.prototypes.is_empty() {
            ('-', 0.0, String::new())
        } else if classify::ink_fraction(&d) < classify::EMPTY_INK {
            ('.', 0.0, String::new())
        } else {
            let (p, dd) = classify::nearest(&d, &cfg.prototypes);
            (p, dd, format!("  nearest={p} d={dd:.3}"))
        };
        println!(
            "  {}{}  ink={:.3}  rgb=({:3.0},{:3.0},{:3.0})  -> {}{}",
            (b'a' + file as u8) as char,
            rank + 1,
            classify::ink_fraction(&d),
            c[0],
            c[1],
            c[2],
            piece,
            note
        );
    }
    Ok(())
}

/// Locate the board in one frame and persist it.
fn detect_board(cfg: &mut config::Config, path: &std::path::Path, source: &capture::Source) -> Result<()> {
    let frame = source.grab()?;
    let r = chesscan::read::detect_board(&frame, cfg)
        .context("no chessboard found in the frame; pass --rect x,y,w,h manually")?;
    cfg.board = r;
    cfg.save(path)?;
    println!(
        "board detected: {}x{} at {},{}  (saved to {})",
        cfg.board.w,
        cfg.board.h,
        cfg.board.x,
        cfg.board.y,
        path.display()
    );
    Ok(())
}

fn parse_rect(s: &str) -> Result<config::BoardRect> {
    let parts: Vec<u32> = s
        .split(',')
        .map(|p| p.trim().parse::<u32>())
        .collect::<std::result::Result<_, _>>()
        .context("--rect must be x,y,w,h in pixels")?;
    if parts.len() != 4 {
        bail!("--rect must be exactly x,y,w,h");
    }
    if parts[2] < 64 || parts[3] < 64 {
        bail!("board rect must be at least 64x64");
    }
    Ok(config::BoardRect {
        x: parts[0],
        y: parts[1],
        w: parts[2],
        h: parts[3],
    })
}

fn snapshot(args: &Args, cfg: &config::Config, source: &capture::Source) -> Result<()> {
    let frame = source.grab()?;
    let board_img = capture::crop(&frame, &cfg.board)?;
    let board = read_board(&board_img, cfg)?;
    print_board(&board);
    let fen = fen::to_fen(&board, args.white_to_move.unwrap_or(true))?;
    println!("FEN: {fen}");
    Ok(())
}

fn calibrate(
    args: &Args,
    cfg: &mut config::Config,
    cfg_path: &std::path::Path,
    source: &capture::Source,
) -> Result<()> {
    let frame = source.grab()?;
    let board_img = capture::crop(&frame, &cfg.board)?;
    let patches = capture::square_patches(&board_img, cfg.white_bottom);
    let descs: Vec<Vec<f32>> = patches
        .iter()
        .map(|(_, p)| classify::descriptor(p))
        .collect();

    let k = args.classes.clamp(2, 32);
    let centroids = classify::kmeans(&descs, k, 50);

    // Show which squares landed in each cluster so labelling is a look, not a guess.
    let mut members: Vec<Vec<String>> = vec![Vec::new(); centroids.len()];
    for (((file, rank), _), d) in patches.iter().zip(descs.iter()) {
        let mut bi = 0;
        let mut bd = f32::MAX;
        for (i, c) in centroids.iter().enumerate() {
            let dd = classify::dist(d, c);
            if dd < bd {
                bd = dd;
                bi = i;
            }
        }
        members[bi].push(format!("{}{}", (b'a' + *file as u8) as char, rank + 1));
    }

    println!("\nLearned {k} clusters. Label each with a FEN piece char.");
    println!("  uppercase white: K Q R B N P   lowercase black: k q r b n p   empty: .\n");

    let preset: Option<Vec<char>> = args.labels.as_ref().map(|s| {
        s.split(',')
            .map(|t| t.trim().chars().next().unwrap_or('.'))
            .collect()
    });

    let stdin = std::io::stdin();
    let mut labels = Vec::with_capacity(centroids.len());
    for (i, c) in centroids.iter().enumerate() {
        let shown: Vec<&String> = members[i].iter().take(6).collect();
        let more = if members[i].len() > 6 {
            format!(" +{}", members[i].len() - 6)
        } else {
            String::new()
        };
        println!(
            "  #{i}  n={:>2}  ink={:.3}  [{}{}]",
            members[i].len(),
            classify::ink_fraction(c),
            shown
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            more
        );
        let ch = match &preset {
            Some(v) => v.get(i).copied().unwrap_or('.'),
            None => {
                print!("      piece> ");
                std::io::stdout().flush()?;
                let mut line = String::new();
                stdin.lock().read_line(&mut line)?;
                line.trim().chars().next().unwrap_or('.')
            }
        };
        let ch = if "KQRBNPkqrbnp.".contains(ch) {
            ch
        } else {
            '.'
        };
        labels.push(ch);
    }

    cfg.prototypes = centroids
        .into_iter()
        .enumerate()
        .map(|(i, features)| config::Prototype {
            piece: labels[i],
            features,
        })
        .collect();
    cfg.save(cfg_path)?;
    println!("\nprototypes saved to {}", cfg_path.display());

    let board = read_board(&board_img, cfg)?;
    print_board(&board);
    println!("FEN: {}", fen::to_fen(&board, true)?);
    Ok(())
}

fn retry_with_redetect(frame: &image::RgbImage, cfg: &mut config::Config, cfg_path: &std::path::Path) {
    match chesscan::read::detect_board(frame, cfg) {
        Ok(r) => {
            cfg.board = r;
            let _ = cfg.save(cfg_path);
            eprintln!("re-detected board: {}x{} at {},{}", r.w, r.h, r.x, r.y);
        }
        Err(e) => eprintln!("re-detect failed ({e}); keeping the previous rect"),
    }
}

fn run(
    args: &Args,
    cfg: &mut config::Config,
    cfg_path: &std::path::Path,
    source: &capture::Source,
) -> Result<()> {
    let hud = if args.no_hud {
        None
    } else {
        let anchor = (
            cfg.board.x as i32 + cfg.board.w as i32 + 16,
            cfg.board.y as i32,
        );
        match overlay::Hud::spawn(anchor) {
            Ok(h) => Some(h),
            Err(e) => {
                eprintln!("HUD unavailable ({e}); continuing headless");
                None
            }
        }
    };

    let mut eng = engine::Engine::spawn(&cfg.engine_path)?;
    let mut white_to_move = args.white_to_move.unwrap_or(true);

    let mut last_board = fen::empty_board();
    let mut last_placement = String::new();
    let mut stable_change = 0u32;
    // A stale rect (window moved, resolution changed) shows up as a run of bad
    // reads. Three in a row is enough to stop trusting it and look again.
    let mut fails = 0u32;

    println!("scanning. board changes flip the side to move. ctrl-c to stop.");
    loop {
        let frame = match source.grab() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("capture: {e}");
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        };
        let board_img = match capture::crop(&frame, &cfg.board) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("crop: {e}");
                fails += 1;
                if args.auto && fails >= 3 {
                    retry_with_redetect(&frame, cfg, cfg_path);
                    fails = 0;
                }
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        };

        let board = match read_board(&board_img, cfg) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("read: {e}");
                fails += 1;
                if args.auto && fails >= 3 {
                    retry_with_redetect(&frame, cfg, cfg_path);
                    fails = 0;
                }
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        };

        let changed = board != last_board;
        if changed {
            // Require the board to hold still for one full cycle before trusting
            // it: mid-animation frames otherwise read as half a knight everywhere.
            stable_change += 1;
            last_board = board;
            if stable_change < 2 {
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        }
        stable_change = 0;

        // Dedupe on the *placement*, not the FEN: the FEN carries the side to
        // move, which we flip ourselves, so comparing FENs makes the loop
        // ping-pong forever on an unchanged board.
        let placement: String = board.iter().collect();
        if placement == last_placement {
            std::thread::sleep(Duration::from_millis(args.interval_ms));
            continue;
        }
        let first_detection = last_placement.is_empty();
        let next_side = if first_detection {
            white_to_move
        } else {
            !white_to_move
        };

        let fen_now = match fen::to_fen(&board, next_side) {
            Ok(f) => f,
            Err(e) => {
                // Do not commit a bad read: leave last_placement alone so the
                // next frame retries instead of silently freezing on garbage.
                eprintln!("fen: {e}");
                fails += 1;
                if args.auto && fails >= 3 {
                    retry_with_redetect(&frame, cfg, cfg_path);
                    fails = 0;
                }
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        };
        last_placement = placement;
        white_to_move = next_side;
        fails = 0;

        println!(
            "[{}] {}",
            if white_to_move {
                "white to move"
            } else {
                "black to move"
            },
            fen_now
        );

        let lines = match eng.analyze(&fen_now, cfg.depth, cfg.multipv) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("\nengine: {e}");
                std::thread::sleep(Duration::from_millis(args.interval_ms));
                continue;
            }
        };

        let mut hud_lines = Vec::new();
        for pv in &lines {
            let win = (engine::win_probability(pv.score, white_to_move) * 100.0).round() as u32;
            let eval = match pv.score {
                engine::Score::Cp(cp) => {
                    let w = engine::white_cp(pv.score, white_to_move).unwrap_or(cp);
                    format!(
                        "{}{:.2}",
                        if w >= 0 { "+" } else { "-" },
                        (w.abs() as f64) / 100.0
                    )
                }
                engine::Score::Mate(m) => format!("M{}", m),
            };
            let first = pv.pv.first().cloned().unwrap_or_default();
            let (from, to) = fen::uci_to_squares(&first)
                .map(|(a, b)| (Some(a), Some(b)))
                .unwrap_or((None, None));
            hud_lines.push(overlay::HudLine {
                text: format!("#{} {}", pv.multipv, first),
                eval,
                win,
                best: pv.multipv == 1,
                from,
                to,
            });
        }
        if let Some(h) = &hud {
            h.update(overlay::HudState {
                lines: hud_lines.clone(),
                fen_ok: true,
                note: format!(
                    "{} nodes  depth {}",
                    "-",
                    lines.first().map(|l| l.depth).unwrap_or(0)
                ),
            });
        }
        for l in &hud_lines {
            println!("  {}  {}  {}%", l.text, l.eval, l.win);
        }

        std::thread::sleep(Duration::from_millis(args.interval_ms));
    }
}
