// Coach window. The recorded tab hides chesscan's arrow and panel; this window
// is a different browser window, so it is not part of the tab capture. It reads
// the panel text the content script mirrors and shows the move in plain type.

const $ = id => document.getElementById(id);
let startedAt = null;

const mmss = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

// chesscan's `.line .san` holds the whole principal variation ("1. e4 e6 2. …"),
// not one move. The move to play is its first SAN token, whatever colour it is.
const firstSan = pv => {
  if (!pv) return "";
  for (const token of pv.trim().split(/\s+/)) {
    if (/^\d+\.(\.\.)?$/.test(token)) continue;
    return token.replace(/[!?]+$/, "");
  }
  return "";
};

const turnText = turn => (turn === "b" ? "black to move" : turn === "w" ? "white to move" : "");

function clear() {
  for (const id of ["move", "score", "prob", "turn", "pvline", "fen"]) $(id).textContent = id === "move" ? "—" : "";
  $("alts").replaceChildren();
}

function renderPanel(data) {
  if (!data || !data.present) {
    clear();
    $("hint").textContent = "chesscan panel not found on this board";
    return;
  }

  const lines = data.lines ?? [];
  const best = lines.find(line => line.best) ?? lines[0] ?? null;
  const move = firstSan(best?.san);

  $("move").textContent = move || "—";
  $("score").textContent = best?.score || "";
  $("prob").textContent = data.prob || "";
  $("turn").textContent = turnText(data.turn);
  $("pvline").textContent = best?.san && best.san !== move ? best.san : "";
  $("fen").textContent = data.fen || "";
  $("hint").textContent = data.status || (best ? "" : "waiting for the engine");

  $("alts").replaceChildren(
    ...lines
      .filter(line => line !== best)
      .slice(0, 3)
      .map(line => {
        const li = document.createElement("li");
        const san = document.createElement("span");
        san.className = "san";
        san.textContent = firstSan(line.san) || line.san;
        const score = document.createElement("span");
        score.textContent = line.score;
        li.append(san, score);
        return li;
      }),
  );
}

function tick() {
  $("time").textContent = startedAt ? mmss(Date.now() - startedAt) : "00:00";
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "coach-panel") renderPanel(msg.data);
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  $("stop").textContent = "Stopping…";
  await chrome.runtime.sendMessage({ type: "recorder-stop" }).catch(() => {});
  window.close();
});

(async () => {
  const res = await chrome.runtime.sendMessage({ type: "coach-hello" }).catch(() => null);
  startedAt = res?.startedAt ?? null;
  renderPanel(res?.panel);
  if (!res?.recording) {
    $("hint").textContent = "not recording";
    $("stop").disabled = true;
  }
  tick();
  setInterval(tick, 500);
})();