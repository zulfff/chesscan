// Content script on chess.com. Two jobs:
//
//   1. Hide chesscan's arrow layer and panel while a recording is running, by
//      injecting one !important stylesheet. A stylesheet beats the inline
//      `display` chesscan toggles, and it also covers elements that chesscan
//      re-creates later.
//   2. Mirror the panel's text to the service worker, so the coach window can
//      show the suggested move while the game tab stays clean. Reading the
//      panel does not depend on it being visible.
//
// The recorder is a separate extension from chesscan on purpose: this file
// reaches the open shadow root by id and never imports chesscan code.

const STYLE_ID = "chesscan-rec-hide";
const PANEL_ID = "chesscan-ext-root";
const POLL_MS = 300;
const HEARTBEAT_MS = 3000;

let active = false;
let hide = { arrow: true, panel: true };
let timer = null;
let lastSent = "";
let lastAt = 0;

function applyHide() {
  let style = document.getElementById(STYLE_ID);
  const css = [
    hide.arrow ? "#chesscan-arrow-layer{display:none!important}" : "",
    hide.panel ? `#${PANEL_ID}{display:none!important}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

// chess.com renders its board as one SVG, so the rank labels are the only way
// to tell which way round the user's board is. White at the bottom means rank 8
// sits above rank 1.
function boardFlipped() {
  const board = document.querySelector("wc-chess-board");
  const labels = [...(board?.querySelectorAll("svg.coordinates text") ?? [])];
  const byRank = rank => labels.find(el => el.textContent.trim() === String(rank));
  const eight = byRank(8);
  const one = byRank(1);
  if (!eight || !one) return false;
  return eight.getBoundingClientRect().top > one.getBoundingClientRect().top;
}

function snapshot() {
  const root = document.getElementById(PANEL_ID)?.shadowRoot;
  if (!root) return { present: false, url: location.href, flipped: boardFlipped() };

  const text = id => root.getElementById(id)?.textContent?.trim() ?? "";
  const lines = [...root.querySelectorAll("#lines li")]
    .map(li => ({
      san: li.querySelector(".san")?.textContent?.trim() ?? "",
      score: li.querySelector(".sc")?.textContent?.trim() ?? "",
      best: li.classList.contains("best"),
      chosen: li.classList.contains("chosen"),
      pinned: li.classList.contains("pinned"),
      uci: li.dataset?.uci ?? "",
    }))
    .filter(line => line.san)
    .slice(0, 4);

  return {
    present: true,
    url: location.href,
    fen: text("fen"),
    turn: text("turn"),
    why: text("why"),
    prob: text("prob"),
    status: text("status"),
    flipped: boardFlipped(),
    lines,
  };
}

function poll() {
  if (!active) return;
  const data = snapshot();
  const json = JSON.stringify(data);
  const now = Date.now();
  if (json === lastSent && now - lastAt < HEARTBEAT_MS) return;
  lastSent = json;
  lastAt = now;
  chrome.runtime.sendMessage({ type: "panel", data }).catch(() => {});
}

function start(config) {
  active = true;
  if (config?.hide) hide = { arrow: config.hide.arrow !== false, panel: config.hide.panel !== false };
  applyHide();
  lastSent = "";
  lastAt = 0;
  poll();
  clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
}

function stop() {
  active = false;
  clearInterval(timer);
  timer = null;
  lastSent = "";
  document.getElementById(STYLE_ID)?.remove();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== "recorder") return;
  if (msg.cmd === "start") {
    start(msg);
    reply({ ok: true });
    return true;
  }
  if (msg.cmd === "stop") {
    stop();
    reply({ ok: true });
    return true;
  }
  if (msg.cmd === "state") {
    reply({ active, hide });
    return true;
  }
});

// A page loaded mid-recording (reload, navigation) asks whether it should be
// hiding anything. The service worker answers from its session state.
chrome.runtime
  .sendMessage({ type: "recorder-hello" })
  .then(res => {
    if (res?.recording) start(res);
  })
  .catch(() => {});
