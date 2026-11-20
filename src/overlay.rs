//! Always-on-top HUD.
//!
//! Design note, and I will die on this hill: per-pixel-alpha arrows drawn *over*
//! the board are the sexy idea and a maintenance trap. softbuffer hands you an
//! XRGB8888 buffer with no alpha channel, so "transparent overlay" becomes a
//! platform-specific ARGB-visual adventure. Instead the HUD is a small opaque
//! panel pinned next to the board: best line, eval, win%, and a mini 8x8 diagram
//! with the arrow already drawn in it. Same information, none of the compositor
//! roulette. Swapping in a real transparent arrow layer later is a contained job.

use std::num::NonZeroU32;
use std::sync::Arc;

use winit::application::ApplicationHandler;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowId, WindowLevel};

pub const W: u32 = 340;
pub const H: u32 = 300;

/// Everything the HUD needs to paint one frame.
#[derive(Clone, Debug, Default)]
pub struct HudState {
    pub lines: Vec<HudLine>,
    pub fen_ok: bool,
    pub note: String,
}

#[derive(Clone, Debug, Default)]
pub struct HudLine {
    pub text: String,
    pub eval: String,
    pub win: u32,
    pub best: bool,
    pub from: Option<usize>,
    pub to: Option<usize>,
}

pub enum UserMsg {
    State(HudState),
}

pub struct Hud {
    proxy: EventLoopProxy<UserMsg>,
}

impl Hud {
    /// Spawn the HUD on its own thread. Returns a handle for pushing updates.
    ///
    /// The EventLoop is built *inside* the worker because it is `!Send` on
    /// several backends; the proxy is handed back over a channel once it exists.
    /// (On macOS this must be the main thread; this project targets Linux.)
    pub fn spawn(anchor: (i32, i32)) -> std::io::Result<Hud> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok(event_loop) = EventLoop::<UserMsg>::with_user_event().build() else {
                return;
            };
            let proxy = event_loop.create_proxy();
            if tx.send(proxy).is_err() {
                return;
            }
            let mut app = HudApp {
                window: None,
                surface: None,
                state: HudState::default(),
                anchor,
            };
            let _ = event_loop.run_app(&mut app);
        });
        let proxy = rx.recv().map_err(std::io::Error::other)?;
        Ok(Hud { proxy })
    }

    pub fn update(&self, s: HudState) {
        let _ = self.proxy.send_event(UserMsg::State(s));
    }
}

struct HudApp {
    window: Option<Arc<Window>>,
    surface: Option<softbuffer::Surface<Arc<Window>, Arc<Window>>>,
    state: HudState,
    anchor: (i32, i32),
}

impl ApplicationHandler<UserMsg> for HudApp {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("chesscan")
            .with_inner_size(PhysicalSize::new(W, H))
            .with_position(PhysicalPosition::new(self.anchor.0, self.anchor.1))
            .with_resizable(false)
            .with_decorations(false)
            .with_window_level(WindowLevel::AlwaysOnTop);
        match el.create_window(attrs) {
            Ok(w) => {
                let w = Arc::new(w);
                if let Ok(ctx) = softbuffer::Context::new(w.clone()) {
                    if let Ok(surf) = softbuffer::Surface::new(&ctx, w.clone()) {
                        self.surface = Some(surf);
                    }
                }
                // Click-through: the HUD must never steal a mouse event from the board.
                let _ = w.set_cursor_hittest(false);
                w.request_redraw();
                self.window = Some(w);
            }
            Err(e) => {
                eprintln!("HUD window failed: {e}");
                el.exit();
            }
        }
    }

    fn user_event(&mut self, _el: &ActiveEventLoop, msg: UserMsg) {
        match msg {
            UserMsg::State(s) => {
                self.state = s;
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
        }
    }

    fn window_event(&mut self, _el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if let WindowEvent::RedrawRequested = event {
            self.paint();
        }
    }
}

impl HudApp {
    fn paint(&mut self) {
        let (Some(_win), Some(surface)) = (self.window.clone(), self.surface.as_mut()) else {
            return;
        };
        let (w, h) = (NonZeroU32::new(W).unwrap(), NonZeroU32::new(H).unwrap());
        if surface.resize(w, h).is_err() {
            return;
        }
        let Ok(mut buf) = surface.buffer_mut() else {
            return;
        };

        let mut canvas = vec![0u32; (W * H) as usize];
        paint_panel(&mut canvas);
        paint_state(&mut canvas, &self.state);
        buf.copy_from_slice(&canvas);
        let _ = buf.present();
    }
}

// --- tiny immediate-mode drawing -------------------------------------------

fn put(px: &mut [u32], x: i32, y: i32, c: u32) {
    if x < 0 || y < 0 || x >= W as i32 || y >= H as i32 {
        return;
    }
    px[(y as u32 * W + x as u32) as usize] = c;
}

fn rect(px: &mut [u32], x: i32, y: i32, w: i32, h: i32, c: u32) {
    for yy in y..y + h {
        for xx in x..x + w {
            put(px, xx, yy, c);
        }
    }
}

const BG: u32 = 0x0013_1218;
const EDGE: u32 = 0x0038_3548;
const TXT: u32 = 0x00E8_E6F0;
const DIM: u32 = 0x0088_8498;
const GOOD: u32 = 0x0058_D69A;
const BAD: u32 = 0x00E0_6C6C;
const ACCENT: u32 = 0x00F2_B455;

fn paint_panel(px: &mut [u32]) {
    rect(px, 0, 0, W as i32, H as i32, EDGE);
    rect(px, 1, 1, W as i32 - 2, H as i32 - 2, BG);
    rect(px, 1, 1, 3, H as i32 - 2, ACCENT);
}

/// 5x7 glyphs, hand-rolled so the HUD has zero font dependencies.
/// Each byte is one column, bit 0 = top row.
fn glyph(ch: char) -> [u8; 5] {
    match ch.to_ascii_uppercase() {
        'A' => [0x7E, 0x11, 0x11, 0x11, 0x7E],
        'B' => [0x7F, 0x49, 0x49, 0x49, 0x36],
        'C' => [0x3E, 0x41, 0x41, 0x41, 0x22],
        'D' => [0x7F, 0x41, 0x41, 0x22, 0x1C],
        'E' => [0x7F, 0x49, 0x49, 0x49, 0x41],
        'F' => [0x7F, 0x09, 0x09, 0x09, 0x01],
        'G' => [0x3E, 0x41, 0x49, 0x49, 0x7A],
        'H' => [0x7F, 0x08, 0x08, 0x08, 0x7F],
        'I' => [0x00, 0x41, 0x7F, 0x41, 0x00],
        'J' => [0x20, 0x40, 0x41, 0x3F, 0x01],
        'K' => [0x7F, 0x08, 0x14, 0x22, 0x41],
        'L' => [0x7F, 0x40, 0x40, 0x40, 0x40],
        'M' => [0x7F, 0x02, 0x0C, 0x02, 0x7F],
        'N' => [0x7F, 0x04, 0x08, 0x10, 0x7F],
        'O' => [0x3E, 0x41, 0x41, 0x41, 0x3E],
        'P' => [0x7F, 0x09, 0x09, 0x09, 0x06],
        'Q' => [0x3E, 0x41, 0x51, 0x21, 0x5E],
        'R' => [0x7F, 0x09, 0x19, 0x29, 0x46],
        'S' => [0x46, 0x49, 0x49, 0x49, 0x31],
        'T' => [0x01, 0x01, 0x7F, 0x01, 0x01],
        'U' => [0x3F, 0x40, 0x40, 0x40, 0x3F],
        'V' => [0x1F, 0x20, 0x40, 0x20, 0x1F],
        'W' => [0x7F, 0x20, 0x18, 0x20, 0x7F],
        'X' => [0x63, 0x14, 0x08, 0x14, 0x63],
        'Y' => [0x03, 0x04, 0x78, 0x04, 0x03],
        'Z' => [0x61, 0x51, 0x49, 0x45, 0x43],
        '0' => [0x3E, 0x51, 0x49, 0x45, 0x3E],
        '1' => [0x00, 0x42, 0x7F, 0x40, 0x00],
        '2' => [0x42, 0x61, 0x51, 0x49, 0x46],
        '3' => [0x21, 0x41, 0x45, 0x4B, 0x31],
        '4' => [0x18, 0x14, 0x12, 0x7F, 0x10],
        '5' => [0x27, 0x45, 0x45, 0x45, 0x39],
        '6' => [0x3C, 0x4A, 0x49, 0x49, 0x30],
        '7' => [0x01, 0x71, 0x09, 0x05, 0x03],
        '8' => [0x36, 0x49, 0x49, 0x49, 0x36],
        '9' => [0x06, 0x49, 0x49, 0x29, 0x1E],
        '+' => [0x08, 0x08, 0x3E, 0x08, 0x08],
        '-' => [0x08, 0x08, 0x08, 0x08, 0x08],
        '.' => [0x00, 0x60, 0x60, 0x00, 0x00],
        ':' => [0x00, 0x36, 0x36, 0x00, 0x00],
        '%' => [0x62, 0x64, 0x08, 0x13, 0x23],
        '/' => [0x20, 0x10, 0x08, 0x04, 0x02],
        '=' => [0x14, 0x14, 0x14, 0x14, 0x14],
        '_' => [0x40, 0x40, 0x40, 0x40, 0x40],
        '#' => [0x28, 0x7C, 0x28, 0x7C, 0x28],
        _ => [0x00, 0x00, 0x00, 0x00, 0x00],
    }
}

fn text(px: &mut [u32], x: i32, y: i32, s: &str, color: u32) {
    for (i, ch) in s.chars().enumerate() {
        let g = glyph(ch);
        let ox = x + i as i32 * 6;
        for (col, bits) in g.iter().enumerate() {
            for row in 0..7 {
                if bits & (1 << row) != 0 {
                    put(px, ox + col as i32, y + row, color);
                }
            }
        }
    }
}

fn paint_state(px: &mut [u32], s: &HudState) {
    text(px, 12, 10, "CHESSCAN", ACCENT);
    text(
        px,
        12,
        24,
        if s.fen_ok {
            "BOARD: LOCKED"
        } else {
            "BOARD: SEARCHING"
        },
        DIM,
    );

    let mut y = 42;
    for (i, l) in s.lines.iter().enumerate() {
        let c = if l.best { GOOD } else { TXT };
        text(px, 12, y, &format!("{}.", i + 1), DIM);
        text(px, 30, y, &l.text, c);
        let wcol = if l.win >= 50 { GOOD } else { BAD };
        text(px, 200, y, &l.eval, if l.best { GOOD } else { DIM });
        text(px, 260, y, &format!("{}%", l.win), wcol);
        y += 14;
    }

    // mini board, bottom right
    let (bx, by, cell) = (218i32, 100i32, 16i32);
    for r in 0..8 {
        for f in 0..8 {
            let light = (r + f) % 2 == 0;
            rect(
                px,
                bx + f * cell,
                by + r * cell,
                cell,
                cell,
                if light { 0x0057_5238 } else { 0x0032_301F },
            );
        }
    }
    if let Some(l) = s.lines.iter().find(|l| l.from.is_some() && l.to.is_some()) {
        let (from, to) = (l.from.unwrap(), l.to.unwrap());
        let mv = |idx: usize| -> (i32, i32) {
            let f = (idx % 8) as i32;
            let r = 7 - (idx / 8) as i32;
            (bx + f * cell + cell / 2, by + r * cell + cell / 2)
        };
        let (x0, y0) = mv(from);
        let (x1, y1) = mv(to);
        for t in 0..=64 {
            let a = t as f32 / 64.0;
            let x = (x0 as f32 + (x1 - x0) as f32 * a) as i32;
            let yy = (y0 as f32 + (y1 - y0) as f32 * a) as i32;
            rect(px, x - 1, yy - 1, 3, 3, ACCENT);
        }
        rect(px, x1 - 3, y1 - 3, 7, 7, GOOD);
    }

    text(px, 12, H as i32 - 18, &s.note, DIM);
}
