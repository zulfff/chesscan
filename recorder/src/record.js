// Recorder window. The only place MediaRecorder lives, and the only place that
// holds the finished blob.
//
// A plain extension page, not the service worker (which Chrome kills after ~30 s
// idle) and not an offscreen document (which is torn down with it). Stopping or
// saving here never depends on another window staying alive.

const $ = id => document.getElementById(id);

let recorder = null;
let stream = null;
let chunks = [];
let startedAt = 0;
let blobUrl = null;
let fileName = "";

const MIMES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

const mmss = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function pickMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const type of MIMES) if (MediaRecorder.isTypeSupported(type)) return type;
  return "";
}

function status(text, cls = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${cls}`.trim();
}

function resetButtons() {
  $("stop").disabled = true;
  $("save").hidden = true;
}

async function start({ streamId }) {
  if (recorder) return { ok: false, error: "already recording" };
  if (!streamId) {
    report("start-failed", { error: "no capture stream" });
    return { ok: false, error: "no capture stream" };
  }

  // A second recording starts a fresh file; the previous blob is no longer
  // needed and keeping it would only hold memory.
  if (blobUrl) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
    blobUrl = null;
    fileName = "";
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
        },
      },
    });
  } catch (err) {
    report("start-failed", { error: err.message });
    return { ok: false, error: err.message };
  }

  chunks = [];
  startedAt = Date.now();
  const mime = pickMime();
  const options = { videoBitsPerSecond: 6_000_000 };
  if (mime) options.mimeType = mime;

  try {
    recorder = new MediaRecorder(stream, options);
  } catch (err) {
    stopTracks();
    report("start-failed", { error: err.message });
    return { ok: false, error: err.message };
  }

  recorder.ondataavailable = event => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onstop = finish;

  // Closing the captured tab ends the track; finalize instead of spinning.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {}
    }
  });

  recorder.start(1000);
  $("stop").disabled = false;
  $("save").hidden = true;
  $("time").textContent = "00:00";
  status("recording…", "recording");
  return { ok: true, mime: recorder.mimeType || mime || "video/webm" };
}

function stopTracks() {
  try {
    stream?.getTracks().forEach(track => track.stop());
  } catch {}
  stream = null;
}

function stop() {
  if (!recorder) return { ok: false, error: "not recording" };
  try {
    recorder.stop();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

/** Build the file and hand it back. The page keeps the URL until it closes, so
 * the user can still save from this window even if the automatic download
 * failed. */
function finish() {
  const type = recorder?.mimeType || "video/webm";
  const blob = new Blob(chunks, { type });
  const ms = startedAt ? Date.now() - startedAt : 0;

  stopTracks();
  recorder = null;
  chunks = [];

  blobUrl = URL.createObjectURL(blob);
  fileName = `chesscan-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${
    /mp4/i.test(type) ? "mp4" : "webm"
  }`;
  const mb = (blob.size / 1024 / 1024).toFixed(1);

  resetButtons();
  status(`done · ${mmss(ms)} · ${mb} MB`, "ready");
  const link = $("save");
  link.hidden = false;
  link.href = blobUrl;
  link.download = fileName;

  report("finished", { url: blobUrl, mime: type, bytes: blob.size, ms, fileName });
}

function tick() {
  $("time").textContent = recorder ? mmss(Date.now() - startedAt) : "00:00";
  if (recorder) status(`recording… ${mmss(Date.now() - startedAt)}`, "recording");
}

function report(type, payload) {
  chrome.runtime.sendMessage({ target: "background", type, ...payload }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "recorder") return;
  if (msg.cmd === "start") {
    start(msg)
      .then(reply)
      .catch(err => reply({ ok: false, error: err.message }));
    return true;
  }
  if (msg.cmd === "stop") {
    reply(stop());
    return true;
  }
  if (msg.cmd === "state") {
    reply({ recording: !!recorder, startedAt, fileName });
    return true;
  }
});

$("stop").addEventListener("click", () => {
  $("stop").disabled = true;
  status("finishing…");
  stop();
});

setInterval(tick, 500);
resetButtons();
