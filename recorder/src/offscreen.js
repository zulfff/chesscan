// Offscreen document: the only place MediaRecorder can live in MV3. It takes
// the tab-capture stream id the popup obtained, records video only (the tab
// keeps its own audio), and hands the finished blob URL to the service worker.

let recorder = null;
let stream = null;
let chunks = [];
let startedAt = 0;
let mime = "";

const MIMES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

function pickMime() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const type of MIMES) if (MediaRecorder.isTypeSupported(type)) return type;
  return "";
}

async function start({ streamId }) {
  if (recorder) return { ok: false, error: "already recording" };
  if (!streamId) return { ok: false, error: "no stream id" };

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
    return { ok: false, error: err.message };
  }

  mime = pickMime();
  chunks = [];
  startedAt = Date.now();

  const options = { videoBitsPerSecond: 6_000_000 };
  if (mime) options.mimeType = mime;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    return { ok: false, error: err.message };
  }

  recorder.ondataavailable = event => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onstop = finish;

  // Closing the tab or revoking capture ends the track. Finish the file rather
  // than leaving a recorder spinning on a dead stream.
  const track = stream.getVideoTracks()[0];
  track?.addEventListener("ended", () => {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {}
    }
  });

  recorder.start(1000);
  return { ok: true, mime: recorder.mimeType || mime || "video/webm" };
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

function finish() {
  const type = recorder?.mimeType || mime || "video/webm";
  const blob = new Blob(chunks, { type });
  const url = URL.createObjectURL(blob);
  const ms = startedAt ? Date.now() - startedAt : 0;

  try {
    stream?.getTracks().forEach(track => track.stop());
  } catch {}
  stream = null;
  recorder = null;
  chunks = [];
  startedAt = 0;

  // The worker downloads this URL; keep the blob alive long enough for that.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 120000);

  chrome.runtime
    .sendMessage({ target: "background", type: "finished", url, mime: type, bytes: blob.size, ms })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "start") {
    start(msg)
      .then(reply)
      .catch(err => reply({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "stop") {
    reply(stop());
    return true;
  }
});
