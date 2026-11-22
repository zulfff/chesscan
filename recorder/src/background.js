// Service worker: owns the recording state, the tab capture handshake, the
// injected hide style, the coach window, and the final download.
//
// The popup gets the tab-capture stream id (that call needs the user's click on
// the extension), then hands it here. The offscreen document consumes the id
// and runs MediaRecorder, because a service worker is killed whenever Chrome
// feels like it and MediaRecorder does not survive that.

const KEY = "recorder";
const OFFSCREEN = "src/offscreen.html";
const COACH = "src/coach.html";

// Latest panel snapshot from the recorded tab. Memory only: it is refreshed
// every few seconds while recording, and a reopened coach asks for it again.
let lastPanel = null;
let creating = null;

const isChesscom = url => /^https:\/\/([a-z0-9-]+\.)?chess\.com\//i.test(url || "");

async function readState() {
  const got = await chrome.storage.session.get(KEY);
  return got[KEY] ?? null;
}

async function writeState(state) {
  if (state) await chrome.storage.session.set({ [KEY]: state });
  else await chrome.storage.session.remove(KEY);
  await paintBadge(state);
}

async function paintBadge(state) {
  try {
    await chrome.action.setBadgeText({ text: state ? "REC" : "" });
    if (state) await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
  } catch {
    // badge is decoration; never let it break a recording
  }
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const list = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return list.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN,
        reasons: ["USER_MEDIA"],
        justification: "Record the chess.com tab the user started recording.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

async function tellTab(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "recorder", ...message });
  } catch {
    // tab closed, or loaded before the content script; nothing to restore
  }
}

async function openCoach(state) {
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(COACH),
      type: "popup",
      width: 340,
      height: 420,
      top: 30,
      left: 30,
      focused: true,
    });
    const [tab] = await chrome.tabs.query({ windowId: win.id });
    // --window-size applies to every window Chrome opens, so re-apply the
    // size here; otherwise the coach covers the board on test machines too.
    try {
      await chrome.windows.update(win.id, { width: 340, height: 420, left: 30, top: 30 });
    } catch {}
    state.coachWindowId = win.id;
    state.coachTabId = tab?.id ?? null;
  } catch {
    // the coach is a convenience; recording works without it
  }
}

async function start({ tabId, streamId, hide, coach }) {
  if (await readState()) return { ok: false, error: "already recording" };
  if (!streamId) return { ok: false, error: "no capture stream" };

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "tab is gone" };
  }
  if (!isChesscom(tab.url)) return { ok: false, error: "not a chess.com tab" };

  await ensureOffscreen();
  const res = await toOffscreen({ type: "start", streamId });
  if (!res?.ok) return { ok: false, error: res?.error || "could not start the recorder" };

  const state = {
    tabId,
    startedAt: Date.now(),
    hide: { arrow: hide?.arrow !== false, panel: hide?.panel !== false },
    coach: !!coach,
    coachWindowId: null,
    coachTabId: null,
    mime: res.mime || "video/webm",
  };
  if (state.coach) await openCoach(state);

  await writeState(state);
  await tellTab(tabId, { cmd: "start", hide: state.hide });
  return { ok: true, startedAt: state.startedAt };
}

/**
 * Ask the offscreen document to finalize. It answers with `finished`, which is
 * where the tab is restored and the file is saved; that way a stop requested by
 * the coach, the popup, or a closed tab all take the same path.
 */
async function stop() {
  const state = await readState();
  if (!state) return { ok: false, error: "not recording" };
  await tellTab(state.tabId, { cmd: "stop" });
  try {
    await chrome.action.setBadgeText({ text: "…" });
  } catch {}
  try {
    await toOffscreen({ type: "stop" });
  } catch {
    // no offscreen document means nothing is being recorded; clean up anyway
    await finalize(null);
  }
  return { ok: true };
}

async function finalize(result) {
  const state = await readState();
  if (state) {
    await tellTab(state.tabId, { cmd: "stop" });
    if (state.coachWindowId != null) {
      try {
        await chrome.windows.remove(state.coachWindowId);
      } catch {}
    }
  }
  await writeState(null);
  lastPanel = null;
  if (result?.url) await save(result);
  return { ok: true };
}

async function save({ url, mime, bytes, ms }) {
  const ext = /mp4/i.test(mime || "") ? "mp4" : "webm";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `chesscan-${stamp}.${ext}`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } catch {
    // blob URLs are extension-origin; a tab can always show it and let the
    // user save manually if the downloads API refuses.
    try {
      await chrome.tabs.create({ url });
    } catch {}
  }
  // Give the download a moment to grab the blob before it is revoked.
  setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", url });
    } catch {}
  }, 60000);
}

async function forwardToCoach(data) {
  const state = await readState();
  if (!state?.coachTabId) return;
  try {
    await chrome.tabs.sendMessage(state.coachTabId, { type: "coach-panel", data });
  } catch {
    // coach window closed; the popup still shows the state
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === "offscreen") return;

  switch (msg.type) {
    case "recorder-status":
      readState().then(state =>
        reply({
          recording: !!state,
          state,
          panel: lastPanel,
          tabId: sender.tab?.id ?? null,
        }),
      );
      return true;

    case "recorder-start":
      start(msg)
        .then(reply)
        .catch(err => reply({ ok: false, error: err.message }));
      return true;

    case "recorder-stop":
      stop()
        .then(reply)
        .catch(err => reply({ ok: false, error: err.message }));
      return true;

    case "recorder-hello":
      readState().then(state =>
        reply({
          recording: !!state && state.tabId === sender.tab?.id,
          hide: state?.hide ?? null,
        }),
      );
      return true;

    case "panel":
      lastPanel = msg.data;
      forwardToCoach(msg.data);
      return;

    case "finished":
      finalize(msg)
        .then(reply)
        .catch(err => reply({ ok: false, error: err.message }));
      return true;

    case "coach-hello":
      readState().then(state =>
        reply({
          recording: !!state,
          startedAt: state?.startedAt ?? null,
          panel: lastPanel,
        }),
      );
      return true;

    default:
      return;
  }
});

// Closing the recorded tab ends the recording; closing the coach does not.
chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await readState();
  if (!state) return;
  if (state.coachTabId === tabId) {
    state.coachTabId = null;
    state.coachWindowId = null;
    await writeState(state);
    return;
  }
  if (state.tabId === tabId) await stop();
});

// A navigation tears down the content script's hide style, so stop instead of
// recording a page where the arrow is visible again.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "loading") return;
  const state = await readState();
  if (state && state.tabId === tabId) await stop();
});

chrome.runtime.onStartup.addListener(async () => paintBadge(await readState()));
chrome.runtime.onInstalled.addListener(async () => paintBadge(await readState()));
readState().then(paintBadge).catch(() => {});
