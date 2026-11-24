//! chesscan server.
//!
//! One HTTP endpoint that matters: POST /v1/analyze takes a FEN, runs our own
//! search, optionally solves the position exactly, optionally humanizes the
//! pick, and streams newline-delimited JSON back so the extension can paint a
//! line at every depth.

mod chess;
mod protocol;
mod review;

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tokio::sync::{mpsc, Semaphore};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use chess::board::Board;
use chess::humanize;
use chess::search::Searcher;
use protocol::{lines_out, AnalyzeRequest, Event, PickOut, PlayRequest, SolverOut};

struct AppState {
    token: Option<String>,
    max_jobs: Arc<Semaphore>,
    solver_pieces: u32,
    solver_nodes: u64,
    solver_depth: i32,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        AppState {
            token: self.token.clone(),
            max_jobs: Arc::clone(&self.max_jobs),
            solver_pieces: self.solver_pieces,
            solver_nodes: self.solver_nodes,
            solver_depth: self.solver_depth,
        }
    }
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "chesscan_server=info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = env_or("PORT", 8787);
    let token = std::env::var("CHESSCAN_TOKEN").ok().filter(|s| !s.is_empty());
    let max_jobs = Arc::new(Semaphore::new(env_or("CHESSCAN_MAX_JOBS", num_cpus::get())));
    let solver_pieces = env_or("CHESSCAN_SOLVER_PIECES", 6u32);
    let solver_nodes = env_or("CHESSCAN_SOLVER_NODES", 5_000_000u64);
    let solver_depth = env_or("CHESSCAN_SOLVER_DEPTH", 16i32);

    let state = AppState {
        token,
        max_jobs,
        solver_pieces,
        solver_nodes,
        solver_depth,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(root))
        .route("/v1/health", get(health))
        .route("/v1/analyze", post(analyze))
        .route("/v1/review", post(review_handler))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    info!("chesscan-server listening on {addr}");
    if let Err(e) = axum::serve(listener, app).await {
        warn!("server stopped: {e}");
    }
}

async fn root() -> impl IntoResponse {
    let body = serde_json::json!({
        "name": "chesscan-server",
        "version": env!("CARGO_PKG_VERSION"),
        "endpoints": ["/v1/analyze", "/v1/review", "/v1/health"]
    });
    ([(header::CONTENT_TYPE, "application/json")], body.to_string())
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let body = serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "solver_pieces": state.solver_pieces,
        "max_jobs": state.max_jobs.available_permits(),
    });
    ([(header::CONTENT_TYPE, "application/json")], body.to_string())
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        "{\"error\":\"unauthorized\"}".to_string(),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "application/json")],
        format!("{{\"error\":{}}}", serde_json::Value::String(msg.to_string())),
    )
        .into_response()
}

async fn analyze(State(state): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if let Some(token) = state.token.clone() {
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|v| v == token)
            .unwrap_or(false);
        let header_token = headers
            .get("x-chesscan-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == token)
            .unwrap_or(false);
        if !bearer && !header_token {
            return unauthorized();
        }
    }

    let req: AnalyzeRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(&format!("bad JSON: {e}")),
    };

    let permit = match state.max_jobs.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::CONTENT_TYPE, "application/json")],
                "{\"error\":\"busy\"}".to_string(),
            )
                .into_response()
        }
    };

    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, Infallible>>();
    std::thread::spawn(move || {
        let _permit = permit;
        run_job(req, tx, state.solver_pieces, state.solver_nodes, state.solver_depth);
    });

    let stream = UnboundedReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from_stream(stream))
        .expect("response")
}

fn send(tx: &mpsc::UnboundedSender<Result<Bytes, Infallible>>, ev: Event) {
    match serde_json::to_vec(&ev) {
        Ok(mut buf) => {
            buf.push(b'\n');
            let _ = tx.send(Ok(Bytes::from(buf)));
        }
        Err(e) => warn!("could not serialise event: {e}"),
    }
}

/// POST /v1/review: a finished game comes in as UCI moves, a per-move report
/// streams back as NDJSON, one `move` event per ply and a final `done`.
async fn review_handler(State(state): State<AppState>, headers: HeaderMap, body: String) -> Response {
    if let Some(token) = state.token.clone() {
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|v| v == token)
            .unwrap_or(false);
        let header_token = headers
            .get("x-chesscan-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == token)
            .unwrap_or(false);
        if !bearer && !header_token {
            return unauthorized();
        }
    }

    let req: review::ReviewRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(&format!("bad JSON: {e}")),
    };
    if req.moves.is_empty() {
        return bad_request("no moves to review");
    }

    let permit = match state.max_jobs.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::CONTENT_TYPE, "application/json")],
                "{\"error\":\"busy\"}".to_string(),
            )
                .into_response()
        }
    };

    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, Infallible>>();
    std::thread::spawn(move || {
        let _permit = permit;
        let result = review::review(&req, |ev| match &ev {
            review::ReviewEvent::Error { message } => {
                warn!("review error: {message}");
            }
            _ => send_review(&tx, ev),
        });
        match result {
            Ok(done) => send_review(&tx, done),
            Err(message) => send_review(&tx, review::ReviewEvent::Error { message }),
        }
    });

    let stream = UnboundedReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from_stream(stream))
        .expect("response")
}

fn send_review(tx: &mpsc::UnboundedSender<Result<Bytes, Infallible>>, ev: review::ReviewEvent) {
    match serde_json::to_vec(&ev) {
        Ok(mut buf) => {
            buf.push(b'\n');
            let _ = tx.send(Ok(Bytes::from(buf)));
        }
        Err(e) => warn!("could not serialise review event: {e}"),
    }
}

fn run_job(req: AnalyzeRequest, tx: mpsc::UnboundedSender<Result<Bytes, Infallible>>, solver_pieces: u32, solver_nodes: u64, solver_depth: i32) {
    let mut board = match Board::from_fen(&req.fen) {
        Ok(b) => b,
        Err(e) => {
            send(&tx, Event::Error { message: e });
            return;
        }
    };

    let limits = protocol::clamp_limits(&req);
    let multipv = req.multipv.clamp(1, 8);
    let history = protocol::history_hashes(&req.history);
    let seed = req.seed.clone().unwrap_or_else(|| req.fen.clone());

    let mut searcher = Searcher::new(limits, history);
    let result = searcher.run_with(&mut board, limits, multipv, |depth, lines, nodes| {
        send(
            &tx,
            Event::Info {
                depth,
                lines: lines_out(lines),
                nodes,
            },
        );
    });

    // The humanizer only makes sense with a ranked candidate list.
    let play = req.play.clone();
    let pick = match play {
        Some(p) if wants_pick(&p) => {
            let cands = humanize::candidates_from_lines(&result.lines);
            let mut rng = humanize::Rng::seed_from(&seed);
            let profile = profile_for_request(&p, &seed, &mut rng);
            let branching = humanize::branching_factor(&board);
            let chosen = humanize::choose(&cands, &profile, &mut rng).map(|mut pick| {
                // The think time is about the real position, not the list size.
                pick.think_ms = humanize::think_time(
                    profile.elo,
                    branching as u32,
                    instability(&result.lines),
                    branching <= 1,
                    &mut rng,
                );
                pick
            });
            chosen.map(|p| PickOut {
                uci: p.mv.uci(),
                reason: p.reason,
                cp_loss: p.cp_loss,
                win: p.win,
                glance_win: p.glance_win,
                think_ms: p.think_ms,
                elo: profile.elo,
            })
        }
        _ => None,
    };

    // Exact solving, when the position is small enough to be worth attempting.
    let solver = match chess::solver::solve(
        &board,
        req.solve_pieces.unwrap_or(solver_pieces),
        solver_nodes,
        solver_depth,
    ) {
        Some(r) => SolverOut {
            attempted: true,
            proven: r.proven,
            mate_in: r.mate_in,
            nodes: r.nodes,
        },
        None => SolverOut {
            attempted: false,
            proven: false,
            mate_in: None,
            nodes: 0,
        },
    };

    let bestmove = result
        .lines
        .first()
        .and_then(|l| l.pv.first())
        .map(|m| m.uci());

    send(
        &tx,
        Event::Done {
            depth: result.depth,
            lines: lines_out(&result.lines),
            pick,
            bestmove,
            proven: solver.proven,
            mate_in: solver.mate_in,
            solver,
            nodes: result.nodes,
            time_ms: result.time_ms,
            tt_hits: result.tt_hits,
            tt_probes: result.tt_probes,
        },
    );
}

fn wants_pick(p: &PlayRequest) -> bool {
    match p.mode.as_deref() {
        None => true,
        Some("off") | Some("max") | Some("none") | Some("") => false,
        Some(_) => true,
    }
}

fn profile_for_request(p: &PlayRequest, seed: &str, _rng: &mut humanize::Rng) -> humanize::Profile {
    if p.mode.as_deref() == Some("auto") {
        let mut form = humanize::Form::new(1500, seed);
        let mut profile = form.next();
        apply_overrides(&mut profile, p);
        return profile;
    }
    let elo = p
        .elo
        .or_else(|| p.mode.as_deref().and_then(protocol::preset_elo))
        .unwrap_or(1400);
    let mut profile = humanize::Profile {
        elo,
        ..humanize::Profile::default()
    };
    apply_overrides(&mut profile, p);
    profile
}

fn apply_overrides(profile: &mut humanize::Profile, p: &PlayRequest) {
    if let Some(v) = p.elo {
        profile.elo = v.clamp(400, 2900);
    }
    if let Some(v) = p.aggression {
        profile.aggression = v.clamp(0.0, 1.0);
    }
    if let Some(v) = p.brilliancy {
        profile.brilliancy = v.clamp(0.0, 1.0);
    }
    if let Some(v) = p.mistake {
        profile.mistake = v.clamp(0.0, 1.0);
    }
    profile.ceiling = p.ceiling;
}

/// How close the top two candidates are, 0..1. Used for the think time.
fn instability(lines: &[chess::search::RootLine]) -> f64 {
    if lines.len() < 2 {
        return 0.0;
    }
    let a = humanize::win_probability(lines[0].score);
    let b = humanize::win_probability(lines[1].score);
    (1.0 - (a - b) * 8.0).clamp(0.0, 1.0)
}
