# chesscan recorder

A second, separate extension that records the chess.com tab you are playing in,
without chesscan's arrow or panel in the video.

It records the whole tab — board, clock, chat, move list, page chrome — not a
cropped board. Video only; the tab keeps its own sound.

## Why a separate extension

The recorder is not part of `../extension`. It only needs two things from
chesscan:

- `#chesscan-arrow-layer` and `#chesscan-ext-root`, which it hides with one
  `!important` stylesheet while recording;
- the open shadow root's text, which it mirrors into the coach window.

Nothing is imported, so either extension can be updated without the other.

## The compromise, and how it is paid

A tab capture is pixels. There is no way to show an overlay on screen and hide
that same overlay from a capture of that screen — if you can see it, the
recorder can too. Neither Chrome's `tabCapture` nor `getDisplayMedia` has a
"capture everything except this element" switch, element-level `captureStream`
is not available in Chrome, and extension windows cannot be transparent.

So while recording, the arrow and the panel are hidden **in the tab**. To keep
the suggestion usable, the recorder opens a **coach window**: a separate browser
window that re-draws what was hidden — a board built from chesscan's FEN with an
arrow on the best move (from the line's UCI), its score, how sure chesscan is,
and the next lines. A separate window is not part of the tab, so it never appears
in the video.

That is the trade: clean video, and the arrow one window over instead of on your
board. Both windows are ordinary, movable, resizable — arrange them as you like.

The coach mirrors your board orientation, read off chess.com's rank labels
(its board is one SVG, so there is no square DOM to inspect).

## Two windows, one job

| window | holds |
| --- | --- |
| **recorder** (top-left) | the timer, Stop, and the video itself |
| **coach** (below it) | board + arrow + suggestion, never recorded |

MediaRecorder lives in the recorder window because a service worker is killed
after ~30 s idle and an offscreen document goes down with it. A plain extension
page survives, so stopping and saving do not depend on any other window being
alive.

Stopping works four ways, all the same path:

- **Ctrl+Shift+S** — the useful one, from the board, no alt-tab;
- the recorder window's **Stop recording**;
- the popup's Stop;
- the coach window's Stop.

Saving happens automatically to Downloads (`chesscan-<timestamp>.webm`), and the
recorder window also keeps a **Save to Downloads** button for the finished file
until you close that window — so a download that failed once can still be saved.

## Load it

1. `chrome://extensions` → developer mode → **Load unpacked** → pick this
   `recorder/` folder.
2. Keep chesscan loaded as usual.
3. Open the chess.com tab you want to record.

There is no build step. The files under `src/` are what Chrome loads.

`chrome.tabCapture` only hands out a stream id to an extension Chrome considers
invoked on the tab, so the manifest declares `activeTab` and a `_execute_action`
shortcut (`Ctrl+Shift+E`) alongside the toolbar button. Any real invocation
works — click the icon or press the shortcut. Pin the icon from the puzzle menu
if you would rather click.

**After editing the code, reload the extension** on `chrome://extensions`.
Chrome caches the service-worker script per profile, so a restart alone can keep
serving the old file.

## Use it

- **hide the arrow** / **hide the panel**: what stays out of the video. Both on
  by default.
- **coach window**: the unrecorded window with the suggestion. On by default.
- **Start recording** asks for the tab-capture stream and starts a `.webm`.
  The toolbar badge reads `REC`.
- **Stop** with Ctrl+Shift+S, or from any of the three windows.

Keep the recorded tab visible. A background tab can be throttled by Chrome and
the capture follows the tab's rendering.

## What ends a recording

- pressing Stop;
- closing the recorded tab;
- navigating the recorded tab (the hide style would not exist on the new page);
- closing the recorder window loses the video rather than stopping cleanly;
- closing the coach window does **not** stop it, it only removes the readout.

While recording, chesscan keeps running normally; only its layers are covered.

## Running the live test

```sh
chromium --user-data-dir=<fresh-profile> --remote-debugging-port=9222 \
  --load-extension=<path>/extension/build/chrome \
  --load-extension=<path>/recorder \
  https://www.chess.com/analysis
cd recorder && npm install && npm run test:live
```

Needs `xdotool` on `$DISPLAY` and a fresh profile: the test presses
`_execute_action`, because `tabCapture` refuses a synthetic `openPopup()`, and
`suggested_key` is applied at install time. It then stops with `Ctrl+Shift+S`.
It asserts the tab hides, the recorder window runs, the coach shows a move, the
state clears afterwards, and a file lands in Downloads.

If the popup does not attach over CDP, the test falls back to clicking the Start
button by coordinates, so it checks the flow rather than Chrome's popup plumbing.

For driving the popup from a script, append `?tab=<tabId>` to `popup.html` — it
uses that tab instead of the active one. That path cannot capture, because it is
not a real invocation.

`test/debug.mjs` dumps the tab, the recorder window, the coach and the session
state over CDP; handy when something misbehaves.

## Files

| file | job |
| --- | --- |
| `src/background.js` | state, tab-capture handshake, hide style, both windows, download |
| `src/record.html/js` | the recorder window: MediaRecorder, timer, Stop, Save |
| `src/content.js` | hides chesscan's layers, mirrors the panel text |
| `src/popup.html/js` | start/stop, options, timer |
| `src/coach.html/js` | the unrecorded suggestion window |

## Not built

Whole-screen capture (`chrome.desktopCapture`) instead of the tab. It needs a
picker and a different stream constraint, and it still cannot hide an overlay
from the capture while showing it to you. The split-window design is what makes
this work; screen-vs-tab is a smaller change on top.

Audio: the tab's sound is left alone on purpose. Adding system audio needs
`getDisplayMedia` and a picker, which changes the permission story.