// Service worker: owns the recording state, the tab-capture handshake, the
// injected hide style, the coach window, and the final download.
//
// The popup gets the tab-capture stream id (that call needs the user's click on
// the extension), then hands it here. The recorder window consumes the id and
// runs MediaRecorder, because a service worker is killed whenever Chrome feels
// like it — and with it, any recording left in its hands.

const KEY = "recorder";
const UI_KEY = "recorder-ui";
const RECORD = "src/record.html";
const COACH = "src/coach.html";

// Latest panel snapshot from the recorded tab. Memory only: it is refreshed
// every few seconds while recording, and a reopened coach asks for it again.
let lastPanel = null;

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

async function tellTab(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "recorder", ...message });
  } catch {
    // tab closed, or loaded before the content script; nothing to restore
  }
}

/** Send to the recorder page, retrying until it has finished loading. */
async function toRecorder(message, attempts = 20) {
  const state = await readState();
  if (!state?.uiTabId) throw new Error("recorder window is gone");
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.tabs.sendMessage(state.uiTabId, { target: "recorder", ...message });
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

async function openWindow(url, { width, height, left, top }) {
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width,
    height,
    left,
    top,
    focused: true,
  });
  const [tab] = await chrome.tabs.query({ windowId: win.id });
  // --window-size applies to every window Chrome opens, so re-apply the size.
  try {
    await chrome.windows.update(win.id, { width, height, left, top });
  } catch {}
  return { windowId: win.id, tabId: tab?.id ?? null };
}

async function openCoach(state) {
  try {
    const { windowId, tabId } = await openWindow(COACH, { width: 340, height: 520, left: 20, top: 250 });
    state.coachWindowId = windowId;
    state.coachTabId = tabId;
  } catch {
    // the coach is a convenience; recording works without it
  }
}

/** Open the recorder window once and keep it for every later recording. The
 * handle lives in local storage because the session state is deliberately
 * cleared when a recording ends; losing it would stack a new window each time. */
async function ensureRecorder(state) {
  const ui = await chrome.storage.local.get(UI_KEY).then(got => got[UI_KEY] ?? null);
  if (ui?.tabId != null) {
    try {
      const tab = await chrome.tabs.get(ui.tabId);
      if (tab.windowId != null) {
        state.uiTabId = ui.tabId;
        state.uiWindowId = tab.windowId;
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        return false;
      }
    } catch {}
    await chrome.storage.local.remove(UI_KEY);
  }
  const { windowId, tabId } = await openWindow(RECORD, { width: 380, height: 220, left: 20, top: 20 });
  await chrome.storage.local.set({ [UI_KEY]: { windowId, tabId } });
  state.uiWindowId = windowId;
  state.uiTabId = tabId;
  return true;
}

async function start({ tabId, streamId, hide, coach }) {
  const existing = await readState();
  if (existing) {
    // Leftover state from an interrupted stop: ask the recorder page whether
    // anything is really running instead of refusing forever.
    let alive = false;
    try {
      const res = await chrome.tabs.sendMessage(existing.uiTabId, { target: "recorder", cmd: "state" });
      alive = !!res?.recording;
    } catch {}
    if (alive) return { ok: false, error: "already recording" };
    await writeState(null);
  }
  if (!streamId) return { ok: false, error: "no capture stream" };

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "tab is gone" };
  }
  if (!isChesscom(tab.url)) return { ok: false, error: "not a chess.com tab" };

  const state = {
    tabId,
    startedAt: Date.now(),
    hide: { arrow: hide?.arrow !== false, panel: hide?.panel !== false },
    coach: !!coach,
    coachWindowId: null,
    coachTabId: null,
    uiWindowId: null,
    uiTabId: null,
    mime: null,
  };
  const opened = await ensureRecorder(state);
  await writeState(state);

  let res;
  try {
    res = await toRecorder({ cmd: "start", streamId }, opened ? 40 : 5);
  } catch (err) {
    await writeState(null);
    return { ok: false, error: err.message };
  }
  if (!res?.ok) {
    await writeState(null);
    return { ok: false, error: res?.error || "could not start the recorder" };
  }

  state.mime = res.mime || "video/webm";
  if (state.coach) await openCoach(state);
  await writeState(state);
  await tellTab(tabId, { cmd: "start", hide: state.hide });
  return { ok: true, startedAt: state.startedAt };
}

/**
 * Ask the recorder page to finalize. It answers with `finished`, which is where
 * the tab is restored and the file is saved; that way a stop requested by the
 * recorder window, the coach, the popup, or a hotkey all take the same path.
 */
async function stop() {
  const state = await readState();
  if (!state) return { ok: false, error: "not recording" };
  await tellTab(state.tabId, { cmd: "stop" });
  try {
    await chrome.action.setBadgeText({ text: "…" });
  } catch {}
  try {
    await toRecorder({ cmd: "stop" });
  } catch {
    // no recorder window means nothing is being recorded; clean up anyway
    await finalize(null);
  }
  return { ok: true };
}

/**
 * Drop the session first, then clean up. Doing it the other way round lets the
 * coach window's own tab-closed event land after the clear and resurrect the
 * state — a badge stuck on REC that refuses the next recording.
 */
async function finalize(result) {
  const state = await readState();
  await writeState(null);
  lastPanel = null;
  if (state) {
    await tellTab(state.tabId, { cmd: "stop" });
    if (state.coachWindowId != null) {
      try {
        await chrome.windows.remove(state.coachWindowId);
      } catch {}
    }
  }
  if (result?.url) await save(result);
  return { ok: true };
}

async function save({ url, mime, fileName, bytes, ms }) {
  // The blob URL belongs to the recorder page, which keeps it alive until the
  // window closes. This download is a convenience; the page also shows Save.
  try {
    await chrome.downloads.download({ url, filename: fileName, saveAs: false });
  } catch {
    try {
      await chrome.tabs.create({ url });
    } catch {}
  }
  void mime;
  void bytes;
  void ms;
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
  if (!msg) return;

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

    case "start-failed":
      finalize(null)
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

// A global Stop that works even when neither extra window is visible.
chrome.commands.onCommand.addListener(command => {
  if (command === "recorder-stop") stop().catch(() => {});
});

// Closing the recorded tab ends the recording; closing the coach does not, and
// closing the recorder window loses the video rather than stopping cleanly.
chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await readState();
  if (!state) return;
  if (state.coachTabId === tabId) {
    state.coachTabId = null;
    state.coachWindowId = null;
    await writeState(state);
    return;
  }
  if (state.uiTabId === tabId) {
    await chrome.storage.local.remove(UI_KEY);
    await finalize(null);
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