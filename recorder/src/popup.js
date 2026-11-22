const $ = id => document.getElementById(id);
const PREF = "recorder-prefs";

let tab = null;
let recording = false;
let startedAt = null;

const isChesscom = url => /^https:\/\/([a-z0-9-]+\.)?chess\.com\//i.test(url || "");
const mmss = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function setStatus(text, bad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", bad);
}

function paint() {
  $("go").textContent = recording ? `Stop recording ${startedAt ? mmss(Date.now() - startedAt) : ""}`.trim() : "Start recording";
  $("go").dataset.on = recording ? "1" : "";
  $("go").disabled = false;
  for (const id of ["arrow", "panel", "coach"]) $(id).disabled = recording;
}

async function prefs() {
  const got = await chrome.storage.local.get(PREF);
  const p = got[PREF] ?? {};
  if (typeof p.arrow === "boolean") $("arrow").checked = p.arrow;
  if (typeof p.panel === "boolean") $("panel").checked = p.panel;
  if (typeof p.coach === "boolean") $("coach").checked = p.coach;
}

async function savePrefs() {
  await chrome.storage.local.set({
    [PREF]: { arrow: $("arrow").checked, panel: $("panel").checked, coach: $("coach").checked },
  });
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "recorder-status" }).catch(() => null);
  recording = !!res?.recording;
  startedAt = res?.state?.startedAt ?? null;
  paint();
  if (recording) {
    setStatus(`recording ${mmss(Date.now() - startedAt)} · stop from here or the coach window`);
  } else if (!isChesscom(tab?.url)) {
    setStatus("open a chess.com tab first", true);
    $("go").disabled = true;
  } else {
    setStatus("ready");
    $("go").disabled = false;
  }
}

async function begin() {
  $("go").disabled = true;
  setStatus("starting…");
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({
      type: "recorder-start",
      tabId: tab.id,
      streamId,
      hide: { arrow: $("arrow").checked, panel: $("panel").checked },
      coach: $("coach").checked,
    });
    if (!res?.ok) throw new Error(res?.error || "could not start");
    recording = true;
    startedAt = res.startedAt ?? Date.now();
    paint();
    setStatus("recording — the arrow and panel are hidden in this tab now");
  } catch (err) {
    setStatus(err.message || String(err), true);
    $("go").disabled = false;
  }
}

async function end() {
  $("go").disabled = true;
  setStatus("finishing the file…");
  const res = await chrome.runtime.sendMessage({ type: "recorder-stop" }).catch(err => ({ ok: false, error: err.message }));
  if (!res?.ok) {
    setStatus(res?.error || "could not stop", true);
    $("go").disabled = false;
    return;
  }
  // The download happens when the offscreen document finalizes; the badge and
  // the state clear themselves at that point.
  setStatus("saving to Downloads…");
  setTimeout(refresh, 1200);
}

$("go").addEventListener("click", () => (recording ? end() : begin()));

for (const id of ["arrow", "panel", "coach"]) {
  $(id).addEventListener("change", savePrefs);
}

(async () => {
  // A `?tab=` parameter is for driving the popup from a normal tab (tests and
  // debugging); the toolbar popup has no query string and uses the active tab.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(forced) && forced > 0) tab = await chrome.tabs.get(forced).catch(() => null);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("tab").textContent = tab?.title || tab?.url || "no tab";
  $("tab").title = tab?.url || "";
  await prefs();
  await refresh();
  setInterval(() => {
    if (recording) {
      paint();
      setStatus(`recording ${mmss(Date.now() - startedAt)} · stop from here or the coach window`);
    }
  }, 500);
})();
