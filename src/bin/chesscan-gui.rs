//! Desktop app: capture, detect, calibrate and read the board in one window.
//!
//! Threading model, because an immediate-mode UI must never block:
//!
//!   UI thread  --Cmd-->  worker thread  --Ev-->  UI thread
//!
//! The worker owns capture, the engine subprocess and the scan loop. The UI owns
//! the config and mutates it under a mutex; the worker picks changes up on its
//! next iteration. Nothing on the UI thread does I/O.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eframe::egui;
use image::RgbImage;

use chesscan::read::{detect_board, read_board};
use chesscan::{capture, classify, config, engine, fen};

const PIECES: [char; 14] = ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p', '.', '?'];

fn main() -> eframe::Result<()> {
    let cfg_path = config::resolve_path();
    let cfg = config::Config::load_or_default(&cfg_path).unwrap_or_default();
    let shared = Arc::new(Mutex::new(cfg));

    // --overlay: a small always-on-top panel, like a stream alert. No title bar,
    // no borders, sits above the browser while you play.
    let overlay = std::env::args().any(|a| a == "--overlay");

    // --pos X,Y: where the window opens. Useful on multi-monitor setups, and
    // needed to keep the app out of the way of the board it is scanning.
    let pos = std::env::args()
        .skip_while(|a| a != "--pos")
        .nth(1)
        .and_then(|s| {
            let mut it = s.split(',');
            let x: f32 = it.next()?.trim().parse().ok()?;
            let y: f32 = it.next()?.trim().parse().ok()?;
            Some(egui::pos2(x, y))
        })
        .or_else(|| {
            // Overlay restores its own last position; the full window does not.
            shared
                .lock()
                .unwrap()
                .overlay_pos
                .map(|[x, y]| egui::pos2(x, y))
                .filter(|_| overlay)
        });

    let mut viewport = if overlay {
        egui::ViewportBuilder::default()
            .with_inner_size([352.0, 176.0])
            .with_min_inner_size([300.0, 150.0])
            .with_decorations(false)
            .with_resizable(false)
            .with_always_on_top()
            .with_title("chesscan overlay")
    } else {
        egui::ViewportBuilder::default()
            .with_inner_size([1120.0, 760.0])
            .with_min_inner_size([880.0, 600.0])
            .with_title("chesscan")
    };
    if let Some(p) = pos {
        viewport = viewport.with_position(p);
    }

    let options = eframe::NativeOptions { viewport, ..Default::default() };

    eframe::run_native(
        "chesscan",
        options,
        Box::new(move |_cc| Ok(Box::new(App::new(shared, cfg_path, overlay)))),
    )
}

// ---------------------------------------------------------------------------
// worker protocol
// ---------------------------------------------------------------------------

enum Cmd {
    Start,
    Stop,
    Detect,
    Calibrate,
    SetSide(bool),
    Shutdown,
}

struct Shot {
    w: usize,
    h: usize,
    rgb: Vec<u8>,
    white_bottom: bool,
}

struct LineInfo {
    rank: u32,
    uci: String,
    eval: String,
    win: u32,
    from: Option<usize>,
    to: Option<usize>,
}

struct ClusterView {
    features: Vec<f32>,
    squares: Vec<String>,
    thumb_w: usize,
    thumb_h: usize,
    thumb: Vec<u8>,
    ink: f32,
}

enum Ev {
    Shot(Shot),
    Detected(config::BoardRect),
    /// A detect/calibrate capture has finished, whatever the outcome. The UI
    /// uses this to bring its own window back after hiding it for the grab.
    CaptureDone,
    Analysis {
        fen: String,
        side_white: bool,
        depth: u32,
        lines: Vec<LineInfo>,
    },
    Clusters(Vec<ClusterView>),
    Log(String),
    Error(String),
}

fn worker(
    cmd_rx: Receiver<Cmd>,
    ev_tx: Sender<Ev>,
    cfg: Arc<Mutex<config::Config>>,
    cfg_path: PathBuf,
) {
    let source = capture::Source::new(None, None);
    let mut eng: Option<engine::Engine> = None;
    let mut running = false;
    let mut white_to_move = true;

    let mut last_placement = String::new();
    let mut pending_board = fen::empty_board();
    let mut saw_change = false;
    let mut last_shot = Instant::now() - Duration::from_secs(10);

    loop {
        loop {
            match cmd_rx.try_recv() {
                Ok(Cmd::Shutdown) => return,
                Ok(Cmd::Start) => {
                    let path = cfg.lock().unwrap().engine_path.clone();
                    if eng.is_none() {
                        match engine::Engine::spawn(&path) {
                            Ok(e) => {
                                eng = Some(e);
                                let _ = ev_tx.send(Ev::Log(format!("engine ready: {path}")));
                            }
                            Err(e) => {
                                let _ = ev_tx.send(Ev::Error(format!("engine: {e}")));
                                continue;
                            }
                        }
                    }
                    running = true;
                    let _ = ev_tx.send(Ev::Log("scanning".into()));
                }
                Ok(Cmd::Stop) => {
                    running = false;
                    let _ = ev_tx.send(Ev::Log("stopped".into()));
                }
                Ok(Cmd::SetSide(w)) => {
                    white_to_move = w;
                    last_placement.clear();
                }
                Ok(Cmd::Detect) => {
                    let _ = ev_tx.send(Ev::Log("detecting board...".into()));
                    match source.grab() {
                        Ok(frame) => {
                            let found = {
                                let c = cfg.lock().unwrap();
                                detect_board(&frame, &c)
                            };
                            match found {
                                Ok(rect) => {
                                    let white_bottom = {
                                        let mut c = cfg.lock().unwrap();
                                        c.board = rect;
                                        let _ = c.save(&cfg_path);
                                        c.white_bottom
                                    };
                                    // Show the crop the detector settled on right
                                    // away. Without this the preview stays blank
                                    // until the scan loop starts, and there is no
                                    // way to tell a good grid from a bad one before
                                    // committing to a calibration.
                                    if let Ok(board_img) = capture::crop(&frame, &rect) {
                                        if let Some(shot) = make_shot(&board_img, white_bottom) {
                                            let _ = ev_tx.send(Ev::Shot(shot));
                                        }
                                        // The rect is usable, but say so when some
                                        // squares cannot be read: a floating window
                                        // or an uncalibrated theme is worth knowing
                                        // before blaming the engine for no output.
                                        let unknown = {
                                            let c = cfg.lock().unwrap();
                                            read_board(&board_img, &c)
                                                .map(|b| b.iter().filter(|&&x| x == '?').count())
                                                .unwrap_or(64)
                                        };
                                        if unknown > 0 {
                                            let _ = ev_tx.send(Ev::Log(format!(
                                                "{unknown} squares unreadable; something may be covering the board, or recalibrate for this theme"
                                            )));
                                        }
                                    }
                                    let _ = ev_tx.send(Ev::Detected(rect));
                                    let _ = ev_tx.send(Ev::Log(format!(
                                        "board found: {}x{} at {},{}",
                                        rect.w, rect.h, rect.x, rect.y
                                    )));
                                    last_placement.clear();
                                }
                                Err(e) => {
                                    let _ = ev_tx.send(Ev::Error(e.to_string()));
                                }
                            }
                        }
                        Err(e) => {
                            let _ = ev_tx.send(Ev::Error(format!("capture: {e}")));
                        }
                    }
                    let _ = ev_tx.send(Ev::CaptureDone);
                }
                Ok(Cmd::Calibrate) => {
                    if let Err(e) = calibrate_once(&source, &cfg, &ev_tx) {
                        let _ = ev_tx.send(Ev::Error(format!("calibrate: {e}")));
                    }
                    let _ = ev_tx.send(Ev::CaptureDone);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        if !running {
            std::thread::sleep(Duration::from_millis(60));
            continue;
        }

        let (rect, white_bottom, depth, multipv) = {
            let c = cfg.lock().unwrap();
            (c.board, c.white_bottom, c.depth, c.multipv)
        };
        let interval = 450u64;

        let frame = match source.grab() {
            Ok(f) => f,
            Err(e) => {
                let _ = ev_tx.send(Ev::Error(format!("capture: {e}")));
                std::thread::sleep(Duration::from_millis(600));
                continue;
            }
        };

        let board_img = match capture::crop(&frame, &rect) {
            Ok(b) => b,
            Err(e) => {
                let _ = ev_tx.send(Ev::Error(format!("crop: {e}")));
                std::thread::sleep(Duration::from_millis(600));
                continue;
            }
        };

        // Preview at a sane size: the UI does not need 640px at 3Hz.
        if last_shot.elapsed() > Duration::from_millis(200) {
            last_shot = Instant::now();
            if let Some(shot) = make_shot(&board_img, white_bottom) {
                let _ = ev_tx.send(Ev::Shot(shot));
            }
        }

        let board = {
            let c = cfg.lock().unwrap();
            read_board(&board_img, &c)
        };
        let board = match board {
            Ok(b) => b,
            Err(e) => {
                let _ = ev_tx.send(Ev::Error(format!("read: {e}")));
                std::thread::sleep(Duration::from_millis(interval));
                continue;
            }
        };

        // Debounce: a board caught mid-animation reads as half a knight.
        let changed = board != pending_board;
        pending_board = board;
        if changed {
            if !saw_change {
                saw_change = true;
                std::thread::sleep(Duration::from_millis(interval));
                continue;
            }
            saw_change = false;
        }

        let placement: String = board.iter().collect();
        if placement == last_placement {
            std::thread::sleep(Duration::from_millis(interval));
            continue;
        }
        let first = last_placement.is_empty();
        let side = if first { white_to_move } else { !white_to_move };

        let fen_now = match fen::to_fen(&board, side) {
            Ok(f) => f,
            Err(e) => {
                let _ = ev_tx.send(Ev::Error(format!("board read: {e}")));
                std::thread::sleep(Duration::from_millis(interval));
                continue;
            }
        };
        last_placement = placement;
        white_to_move = side;

        let Some(e) = eng.as_mut() else {
            std::thread::sleep(Duration::from_millis(interval));
            continue;
        };
        match e.analyze(&fen_now, depth, multipv) {
            Ok(pvs) => {
                let mut lines = Vec::new();
                for pv in &pvs {
                    let win = (engine::win_probability(pv.score, side) * 100.0).round() as u32;
                    let eval = match pv.score {
                        engine::Score::Cp(cp) => {
                            let w = engine::white_cp(pv.score, side).unwrap_or(cp);
                            format!(
                                "{}{:.2}",
                                if w >= 0 { "+" } else { "-" },
                                (w.abs() as f64) / 100.0
                            )
                        }
                        engine::Score::Mate(m) => format!("M{m}"),
                    };
                    let first_mv = pv.pv.first().cloned().unwrap_or_default();
                    let (from, to) = fen::uci_to_squares(&first_mv)
                        .map(|(a, b)| (Some(a), Some(b)))
                        .unwrap_or((None, None));
                    lines.push(LineInfo { rank: pv.multipv, uci: first_mv, eval, win, from, to });
                }
                let _ = ev_tx.send(Ev::Analysis { fen: fen_now, side_white: side, depth, lines });
            }
            Err(err) => {
                let _ = ev_tx.send(Ev::Error(format!("engine: {err}")));
            }
        }

        std::thread::sleep(Duration::from_millis(interval));
    }
}

fn make_shot(board: &RgbImage, white_bottom: bool) -> Option<Shot> {
    let (w, h) = (board.width(), board.height());
    if w == 0 || h == 0 {
        return None;
    }
    let max = 420u32;
    let scale = (max as f32 / w.max(h) as f32).min(1.0);
    let nw = ((w as f32 * scale) as u32).max(8);
    let nh = ((h as f32 * scale) as u32).max(8);
    let small = image::imageops::resize(board, nw, nh, image::imageops::FilterType::Triangle);
    Some(Shot { w: nw as usize, h: nh as usize, rgb: small.into_raw(), white_bottom })
}

fn calibrate_once(
    source: &capture::Source,
    cfg: &Arc<Mutex<config::Config>>,
    ev_tx: &Sender<Ev>,
) -> anyhow::Result<()> {
    let (rect, white_bottom) = {
        let c = cfg.lock().unwrap();
        (c.board, c.white_bottom)
    };
    if rect.w == 0 || rect.h == 0 {
        anyhow::bail!("detect the board first");
    }
    let frame = source.grab()?;
    let board_img = capture::crop(&frame, &rect)?;
    if let Some(shot) = make_shot(&board_img, white_bottom) {
        let _ = ev_tx.send(Ev::Shot(shot));
    }
    let patches = capture::square_patches(&board_img, white_bottom);
    let descs: Vec<Vec<f32>> = patches
        .iter()
        .map(|(_, p)| classify::descriptor(p))
        .collect();
    let centroids = classify::kmeans(&descs, 13, 50);

    let mut views = Vec::new();
    for (i, c) in centroids.iter().enumerate() {
        let mut members: Vec<usize> = Vec::new();
        for (idx, d) in descs.iter().enumerate() {
            let mut best = (0usize, f32::MAX);
            for (j, cc) in centroids.iter().enumerate() {
                let dd = classify::dist(d, cc);
                if dd < best.1 {
                    best = (j, dd);
                }
            }
            if best.0 == i {
                members.push(idx);
            }
        }
        let squares = members
            .iter()
            .map(|idx| {
                let (file, rank) = ((idx % 8) as u32, (idx / 8) as u32);
                format!("{}{}", (b'a' + file as u8) as char, rank + 1)
            })
            .collect::<Vec<_>>();

        let (tw, th, thumb) = match members.first() {
            Some(&idx) => {
                let small =
                    image::imageops::resize(&patches[idx].1, 56, 56, image::imageops::FilterType::Triangle);
                (56usize, 56usize, small.into_raw())
            }
            None => (56, 56, vec![40u8; 56 * 56 * 3]),
        };

        views.push(ClusterView {
            features: c.clone(),
            squares,
            thumb_w: tw,
            thumb_h: th,
            thumb,
            ink: classify::ink_fraction(c),
        });
    }

    let _ = ev_tx.send(Ev::Clusters(views));
    Ok(())
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Pending {
    Detect,
    Calibrate,
}

struct App {
    cfg: Arc<Mutex<config::Config>>,
    cfg_path: PathBuf,
    tx: Sender<Cmd>,
    rx: Receiver<Ev>,
    running: bool,
    overlay: bool,

    /// A capture is about to run: the window is hidden so it cannot cover the
    /// board. Without this, pressing "Detect board" while the app sits on top of
    /// the browser makes detection fail with "no chessboard found", which looks
    /// exactly like a broken detector.
    pending: Option<(Instant, Pending)>,
    /// Window hidden and waiting for the worker to answer; always restored.
    awaiting_show: Option<Instant>,
    startup_detect: bool,
    /// `--calibrate`: after the startup detect succeeds, run one calibration
    /// capture automatically so the dialog opens without a second click.
    startup_calibrate: bool,
    last_error: Option<String>,

    shot_tex: Option<egui::TextureHandle>,
    shot_white_bottom: bool,

    lines: Vec<LineInfo>,
    fen_text: String,
    side_white: bool,
    depth_seen: u32,

    clusters: Option<Vec<ClusterView>>,
    cluster_tex: Vec<egui::TextureHandle>,
    labels: Vec<char>,

    log: Vec<String>,
}

impl App {
    fn new(cfg: Arc<Mutex<config::Config>>, cfg_path: PathBuf, overlay: bool) -> Self {
        let (tx, cmd_rx) = channel();
        let (ev_tx, rx) = channel();
        let cfg2 = cfg.clone();
        let path2 = cfg_path.clone();
        std::thread::spawn(move || worker(cmd_rx, ev_tx, cfg2, path2));

        // --auto: detect and start immediately, for scripted launches.
        let auto = std::env::args().any(|a| a == "--auto");
        let want_calibrate = std::env::args().any(|a| a == "--calibrate");

        let mut app = App {
            cfg,
            cfg_path,
            tx,
            rx,
            running: auto,
            overlay,
            pending: None,
            awaiting_show: None,
            startup_detect: auto || want_calibrate,
            startup_calibrate: want_calibrate,
            last_error: None,
            shot_tex: None,
            shot_white_bottom: true,
            lines: Vec::new(),
            fen_text: String::new(),
            side_white: true,
            depth_seen: 0,
            clusters: None,
            cluster_tex: Vec::new(),
            labels: Vec::new(),
            log: Vec::new(),
        };

        if capture::is_wayland() {
            app.push_log(
                "wayland session: X11 capture usually fails here, use \"GNOME on Xorg\"".into(),
            );
        }
        if app.cfg.lock().unwrap().prototypes.is_empty() {
            app.push_log("no calibration yet: press Detect board, then Calibrate once".into());
        }

        if auto {
            let _ = app.tx.send(Cmd::Start);
        }
        app
    }

    fn push_log(&mut self, s: String) {
        self.log.push(s);
        if self.log.len() > 200 {
            self.log.remove(0);
        }
    }

    /// Hide the window, wait a beat for the compositor, then ask the worker to
    /// grab. Detection must not see our own window: on a 1366-wide laptop the
    /// app covers the board, and "no chessboard found" then looks like a broken
    /// detector rather than a self-occlusion bug.
    fn request_capture(&mut self, ctx: &egui::Context, kind: Pending) {
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
        self.pending = Some((Instant::now() + Duration::from_millis(300), kind));
        self.push_log(match kind {
            Pending::Detect => "detecting board...".into(),
            Pending::Calibrate => "clustering squares...".into(),
        });
    }

    fn restore_window(&mut self, ctx: &egui::Context) {
        if self.awaiting_show.take().is_some() {
            ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        }
    }

    fn pump(&mut self, ctx: &egui::Context) {
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                Ev::Shot(s) => {
                    let img = egui::ColorImage::from_rgb([s.w, s.h], &s.rgb);
                    self.shot_tex =
                        Some(ctx.load_texture("preview", img, egui::TextureOptions::LINEAR));
                    self.shot_white_bottom = s.white_bottom;
                }
                Ev::Detected(_rect) => {
                    self.restore_window(ctx);
                    self.last_error = None;
                    if self.startup_calibrate {
                        self.startup_calibrate = false;
                        self.request_capture(ctx, Pending::Calibrate);
                    }
                }
                Ev::CaptureDone => self.restore_window(ctx),
                Ev::Analysis { fen, side_white, depth, lines } => {
                    self.last_error = None;
                    self.fen_text = fen;
                    self.side_white = side_white;
                    self.depth_seen = depth;
                    self.lines = lines;
                }
                Ev::Clusters(views) => {
                    self.restore_window(ctx);
                    self.cluster_tex = views
                        .iter()
                        .map(|v| {
                            let img = egui::ColorImage::from_rgb([v.thumb_w, v.thumb_h], &v.thumb);
                            ctx.load_texture("cluster", img, egui::TextureOptions::LINEAR)
                        })
                        .collect();
                    self.labels = views
                        .iter()
                        .map(|v| if v.ink < classify::EMPTY_INK { '.' } else { '?' })
                        .collect();
                    self.clusters = Some(views);
                }
                Ev::Log(s) => self.push_log(s),
                Ev::Error(s) => {
                    self.last_error = Some(s.clone());
                    self.push_log(format!("error: {s}"));
                }
            }
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.pump(ctx);
        ctx.request_repaint_after(Duration::from_millis(120));

        // Fire the delayed detect/calibrate once the window has actually gone
        // away. Toolkits do not hide synchronously, so grabbing on the same
        // frame would still capture our own window on some compositors.
        if let Some((at, kind)) = self.pending {
            if Instant::now() >= at {
                self.pending = None;
                self.awaiting_show = Some(Instant::now());
                let _ = self.tx.send(match kind {
                    Pending::Detect => Cmd::Detect,
                    Pending::Calibrate => Cmd::Calibrate,
                });
            }
        }
        // Safety net: never leave the window invisible if the worker is wedged.
        if self
            .awaiting_show
            .map(|t| t.elapsed() > Duration::from_secs(4))
            .unwrap_or(false)
        {
            self.restore_window(ctx);
        }
        if self.startup_detect {
            self.startup_detect = false;
            self.request_capture(ctx, Pending::Detect);
        }

        if self.overlay {
            self.overlay_ui(ctx);
            return;
        }

        egui::SidePanel::left("controls").resizable(false).exact_width(280.0).show(ctx, |ui| {
            ui.add_space(6.0);
            ui.heading("chesscan");
            ui.label(egui::RichText::new("live board scanner").weak());
            ui.add_space(10.0);

            let rect = self.cfg.lock().unwrap().board;
            if rect.w > 0 {
                ui.label(format!("board: {}x{} at {},{}", rect.w, rect.h, rect.x, rect.y));
            } else {
                ui.colored_label(egui::Color32::from_rgb(230, 170, 70), "board: not detected");
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if ui.button("Detect board").clicked() {
                    self.request_capture(ctx, Pending::Detect);
                }
                if ui.button("Calibrate").clicked() {
                    self.request_capture(ctx, Pending::Calibrate);
                }
            });

            ui.add_space(14.0);
            ui.separator();
            ui.add_space(8.0);

            {
                let mut c = self.cfg.lock().unwrap();
                ui.label("engine");
                ui.horizontal(|ui| {
                    ui.add(
                        egui::TextEdit::singleline(&mut c.engine_path)
                            .desired_width(190.0)
                            .hint_text("stockfish"),
                    );
                });
                ui.add_space(6.0);
                ui.add(egui::Slider::new(&mut c.depth, 6..=30).text("depth"));
                ui.add(egui::Slider::new(&mut c.multipv, 1..=5).text("lines"));
                ui.add_space(6.0);
                ui.label("orientation");
                ui.horizontal(|ui| {
                    ui.radio_value(&mut c.white_bottom, true, "white bottom");
                    ui.radio_value(&mut c.white_bottom, false, "black bottom");
                });
            }

            ui.add_space(10.0);
            ui.label("side to move");
            let mut side = self.side_white;
            ui.horizontal(|ui| {
                if ui.radio_value(&mut side, true, "white").changed() {
                    self.side_white = side;
                    let _ = self.tx.send(Cmd::SetSide(true));
                }
                if ui.radio_value(&mut side, false, "black").changed() {
                    self.side_white = side;
                    let _ = self.tx.send(Cmd::SetSide(false));
                }
            });

            ui.add_space(16.0);
            let (label, color) = if self.running {
                ("Stop", egui::Color32::from_rgb(190, 70, 60))
            } else {
                ("Start scanning", egui::Color32::from_rgb(72, 140, 90))
            };
            let btn = egui::Button::new(egui::RichText::new(label).size(16.0).color(egui::Color32::WHITE))
                .fill(color)
                .min_size(egui::vec2(240.0, 38.0));
            if ui.add(btn).clicked() {
                if self.running {
                    let _ = self.tx.send(Cmd::Stop);
                    self.running = false;
                } else {
                    let _ = self.tx.send(Cmd::Start);
                    self.running = true;
                }
            }

            ui.add_space(8.0);
            if ui.button("Save settings").clicked() {
                let res = {
                    let c = self.cfg.lock().unwrap();
                    c.save(&self.cfg_path)
                };
                match res {
                    Ok(()) => self.push_log(format!("saved {}", self.cfg_path.display())),
                    Err(e) => self.push_log(format!("save failed: {e}")),
                }
            }

            ui.add_space(12.0);
            ui.separator();
            ui.label(egui::RichText::new("log").weak());
            egui::ScrollArea::vertical().max_height(160.0).stick_to_bottom(true).show(ui, |ui| {
                for l in &self.log {
                    ui.label(egui::RichText::new(l).small().monospace());
                }
            });
        });

        egui::SidePanel::right("analysis").resizable(true).default_width(300.0).show(ctx, |ui| {
            ui.add_space(6.0);
            ui.heading("evaluation");
            ui.add_space(4.0);

            if self.lines.is_empty() {
                ui.label(egui::RichText::new("no analysis yet").weak());
            } else {
                // win bar
                let win = self.lines[0].win as f32 / 100.0;
                let (bar, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 18.0), egui::Sense::hover());
                let p = ui.painter();
                p.rect_filled(bar, 3.0, egui::Color32::from_rgb(45, 45, 52));
                let mut filled = bar;
                filled.set_width(bar.width() * win);
                p.rect_filled(filled, 3.0, egui::Color32::from_rgb(235, 236, 208));
                p.text(
                    bar.left_top() + egui::vec2(8.0, 2.0),
                    egui::Align2::LEFT_TOP,
                    format!("{:.0}% white", self.lines[0].win),
                    egui::FontId::monospace(11.0),
                    if win > 0.5 { egui::Color32::BLACK } else { egui::Color32::WHITE },
                );

                ui.add_space(10.0);
                for l in &self.lines {
                    let col = if l.rank == 1 {
                        egui::Color32::from_rgb(120, 200, 140)
                    } else {
                        egui::Color32::from_rgb(200, 200, 210)
                    };
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new(format!("{}.", l.rank)).weak().monospace());
                        ui.label(egui::RichText::new(&l.uci).color(col).monospace().strong());
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(egui::RichText::new(format!("{}%", l.win)).monospace().weak());
                            ui.label(egui::RichText::new(&l.eval).monospace().color(col));
                        });
                    });
                }
            }

            ui.add_space(14.0);
            ui.separator();
            ui.label(egui::RichText::new("position").weak());
            ui.add(
                egui::Label::new(egui::RichText::new(&self.fen_text).monospace().small()).wrap(),
            );
            ui.add_space(4.0);
            ui.label(if self.side_white { "white to move" } else { "black to move" });
            if self.depth_seen > 0 {
                ui.label(egui::RichText::new(format!("depth {}", self.depth_seen)).weak().small());
            }
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(err) = &self.last_error {
                egui::Frame::none()
                    .fill(egui::Color32::from_rgb(58, 22, 22))
                    .inner_margin(egui::Margin::same(8.0))
                    .show(ui, |ui| {
                        ui.colored_label(egui::Color32::from_rgb(255, 160, 150), err);
                        if err.contains("capture") && capture::is_wayland() {
                            ui.label(
                                egui::RichText::new(
                                    "Wayland blocks whole-screen capture. Log out and pick \"GNOME on Xorg\" at the login screen, or run with --file.",
                                )
                                .small(),
                            );
                        }
                    });
                ui.add_space(6.0);
            }

            let avail = ui.available_size();
            let side = avail.x.min(avail.y);
            if let Some(tex) = &self.shot_tex {
                let size = egui::vec2(side, side);
                let resp = ui.add(egui::Image::new(tex).fit_to_exact_size(size));
                draw_overlay(ui, resp.rect, &self.lines, self.shot_white_bottom);
            } else {
                ui.vertical_centered(|ui| {
                    ui.add_space(100.0);
                    ui.label(
                        egui::RichText::new("Press \"Detect board\", then \"Start scanning\"")
                            .size(16.0)
                            .weak(),
                    );
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new(
                            "First time on a new theme? Detect, then Calibrate once.",
                        )
                        .weak(),
                    );
                });
            }
        });

        self.calibration_window(ctx);
    }
}

impl App {
    /// The stream-alert panel: always on top, tiny, draggable, nothing to click
    /// except re-detect and start/stop.
    fn overlay_ui(&mut self, ctx: &egui::Context) {
        let frame = egui::Frame::none()
            .fill(egui::Color32::from_rgb(15, 15, 19))
            .inner_margin(egui::Margin::same(9.0))
            .stroke(egui::Stroke::new(1.0_f32, egui::Color32::from_rgb(55, 55, 65)));

        egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
            ui.horizontal(|ui| {
                let handle = ui.add(
                    egui::Label::new(egui::RichText::new("⠿ chesscan").small().weak())
                        .sense(egui::Sense::click_and_drag()),
                );
                if self.running && !self.lines.is_empty() {
                    ui.label(
                        egui::RichText::new(if self.side_white {
                            "white to move"
                        } else {
                            "black to move"
                        })
                        .small()
                        .weak(),
                    );
                }
                if handle.drag_started() {
                    ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
                }
                if handle.drag_stopped() {
                    if let Some(r) = ctx.input(|i| i.viewport().outer_rect) {
                        let np = [r.min.x, r.min.y];
                        let mut c = self.cfg.lock().unwrap();
                        let moved = c
                            .overlay_pos
                            .map(|p| (p[0] - np[0]).abs() > 1.0 || (p[1] - np[1]).abs() > 1.0)
                            .unwrap_or(true);
                        if moved {
                            c.overlay_pos = Some(np);
                            let _ = c.save(&self.cfg_path);
                        }
                    }
                }

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let run = if self.running { "■" } else { "▶" };
                    if ui.small_button(run).clicked() {
                        if self.running {
                            let _ = self.tx.send(Cmd::Stop);
                            self.running = false;
                        } else {
                            let _ = self.tx.send(Cmd::Start);
                            self.running = true;
                        }
                    }
                    if ui
                        .small_button("⇄")
                        .on_hover_text("flip the side to move")
                        .clicked()
                    {
                        let new = !self.side_white;
                        let _ = self.tx.send(Cmd::SetSide(new));
                        self.side_white = new;
                    }
                    if ui.small_button("⟳").clicked() {
                        self.request_capture(ctx, Pending::Detect);
                    }
                    let col = if self.last_error.is_some() {
                        egui::Color32::from_rgb(225, 95, 85)
                    } else if self.running {
                        egui::Color32::from_rgb(95, 205, 125)
                    } else {
                        egui::Color32::from_rgb(150, 150, 150)
                    };
                    ui.label(egui::RichText::new("●").color(col).small());
                });
            });

            ui.add_space(3.0);

            match self.lines.first() {
                Some(l) => {
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!("{}%", l.win))
                                .size(30.0)
                                .strong(),
                        );
                        ui.label(
                            egui::RichText::new("white")
                                .small()
                                .weak(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(
                                egui::RichText::new(format!("{}  {}", l.eval, l.uci))
                                    .monospace()
                                    .size(13.0),
                            );
                        });
                    });

                    let win = l.win as f32 / 100.0;
                    let (bar, _) = ui.allocate_exact_size(
                        egui::vec2(ui.available_width(), 8.0),
                        egui::Sense::hover(),
                    );
                    let p = ui.painter();
                    p.rect_filled(bar, 2.0, egui::Color32::from_rgb(44, 44, 52));
                    let mut filled = bar;
                    filled.set_width(bar.width() * win);
                    p.rect_filled(filled, 2.0, egui::Color32::from_rgb(235, 236, 208));

                    ui.add_space(5.0);
                    for l in self.lines.iter().skip(1).take(2) {
                        ui.label(
                            egui::RichText::new(format!("{}  {}  {}%", l.rank, l.uci, l.win))
                                .monospace()
                                .small()
                                .color(egui::Color32::from_rgb(185, 185, 195)),
                        );
                    }
                }
                None => {
                    ui.label(egui::RichText::new("waiting for board...").weak());
                }
            }

            if let Some(err) = &self.last_error {
                ui.add_space(3.0);
                ui.label(
                    egui::RichText::new(err)
                        .small()
                        .color(egui::Color32::from_rgb(240, 125, 115)),
                );
            }
        });
    }

    fn calibration_window(&mut self, ctx: &egui::Context) {
        if self.clusters.is_none() {
            return;
        }
        let mut open = true;
        let mut apply = false;
        let mut cancel = false;

        egui::Window::new("Calibrate pieces")
            .open(&mut open)
            .collapsible(false)
            .resizable(true)
            .default_width(520.0)
            .show(ctx, |ui| {
                ui.label("Pick what each cluster actually is. Example squares are shown.");
                ui.add_space(6.0);
                let clusters = self.clusters.as_ref().unwrap();
                egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                    for (i, c) in clusters.iter().enumerate() {
                        ui.horizontal(|ui| {
                            if let Some(tex) = self.cluster_tex.get(i) {
                                ui.add(egui::Image::new(tex).fit_to_exact_size(egui::vec2(44.0, 44.0)));
                            }
                            ui.vertical(|ui| {
                                let sample = c.squares.iter().take(5).cloned().collect::<Vec<_>>().join(" ");
                                ui.label(egui::RichText::new(format!("{} ({})", sample, c.squares.len())).small());
                                ui.label(
                                    egui::RichText::new(format!("ink {:.2}", c.ink))
                                        .small()
                                        .weak(),
                                );
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                egui::ComboBox::from_id_salt(("piece", i))
                                    .selected_text(self.labels[i].to_string())
                                    .width(60.0)
                                    .show_ui(ui, |ui| {
                                        for p in PIECES {
                                            ui.selectable_value(&mut self.labels[i], p, p.to_string());
                                        }
                                    });
                            });
                        });
                        ui.separator();
                    }
                });

                let unresolved = self.labels.iter().filter(|c| **c == '?').count();
                if unresolved > 0 {
                    ui.colored_label(
                        egui::Color32::from_rgb(230, 170, 70),
                        format!("{unresolved} cluster(s) still unlabelled"),
                    );
                }
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    if ui.button("Apply").clicked() {
                        apply = true;
                    }
                    if ui.button("Cancel").clicked() {
                        cancel = true;
                    }
                });
            });

        if apply {
            let clusters = self.clusters.take().unwrap();
            let protos: Vec<config::Prototype> = clusters
                .into_iter()
                .enumerate()
                .filter(|(i, _)| self.labels[*i] != '?')
                .map(|(i, c)| config::Prototype { piece: self.labels[i], features: c.features })
                .collect();
            let saved = {
                let mut cfg = self.cfg.lock().unwrap();
                cfg.prototypes = protos;
                cfg.save(&self.cfg_path)
            };
            match saved {
                Ok(()) => self.push_log("prototypes saved".into()),
                Err(e) => self.push_log(format!("save failed: {e}")),
            }
            self.clusters = None;
            self.cluster_tex.clear();
            let _ = self.tx.send(Cmd::SetSide(self.side_white));
        } else if cancel || !open {
            self.clusters = None;
            self.cluster_tex.clear();
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Shutdown);
    }
}

/// Grid + best-move arrow over the preview. This replaces the separate HUD for
/// GUI users: the arrow is drawn in our own window, over our own pixels.
fn draw_overlay(ui: &egui::Ui, rect: egui::Rect, lines: &[LineInfo], white_bottom: bool) {
    let p = ui.painter_at(rect);
    let cell = rect.width() / 8.0;
    let line_col = egui::Color32::from_rgba_unmultiplied(255, 255, 255, 28);

    for i in 0..=8 {
        let x = rect.left() + i as f32 * cell;
        p.line_segment(
            [egui::pos2(x, rect.top()), egui::pos2(x, rect.bottom())],
            egui::Stroke::new(1.0_f32, line_col),
        );
        let y = rect.top() + i as f32 * cell;
        p.line_segment(
            [egui::pos2(rect.left(), y), egui::pos2(rect.right(), y)],
            egui::Stroke::new(1.0_f32, line_col),
        );
    }

    let center = |idx: usize| -> egui::Pos2 {
        let f = (idx % 8) as f32;
        let r = (idx / 8) as f32;
        let row = if white_bottom { 7.0 - r } else { r };
        rect.min + egui::vec2((f + 0.5) * cell, (row + 0.5) * cell)
    };

    if let Some(l) = lines.first() {
        if let (Some(from), Some(to)) = (l.from, l.to) {
            let a = center(from);
            let b = center(to);
            let col = egui::Color32::from_rgb(242, 180, 85);
            p.line_segment([a, b], egui::Stroke::new(cell * 0.16, col));

            let dir = (b - a).normalized();
            let n = egui::vec2(-dir.y, dir.x);
            let head = cell * 0.42;
            let tip = b + dir * head * 0.45;
            let base = b - dir * head * 0.55;
            let poly = vec![tip, base + n * head * 0.42, base - n * head * 0.42];
            p.add(egui::Shape::convex_polygon(
                poly,
                col,
                egui::Stroke::new(1.0_f32, egui::Color32::from_rgb(60, 40, 10)),
            ));
        }
    }
}