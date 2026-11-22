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

## The honest limitation

A tab capture is pixels. There is no way to show an overlay on screen and hide
that same overlay from a capture of that screen — if you can see it, the
recorder can too.

So while recording, the arrow and the panel are hidden **in the tab**. To keep
the suggestion usable, the recorder opens a **coach window**: a separate browser
window showing the move to play, its score, how sure chesscan is, and the next
lines. A separate window is not part of the tab, so it never appears in the
video. Put it beside the board, read the move, play it.

That is the trade: clean video, suggestion one window over.

The move shown is the first SAN of chesscan's best line (its panel lists whole
principal variations). Alternatives show the first move and the score.

## Load it

1. `chrome://extensions` → developer mode → **Load unpacked** → pick this
   `recorder/` folder.
2. Keep chesscan loaded as usual.
3. Open the chess.com tab you want to record.

There is no build step. The files under `src/` are what Chrome loads.

`chrome.tabCapture` only hands out a stream id to an extension Chrome considers
invoked on the tab, so the manifest declares `activeTab` and a
`_execute_action` keyboard shortcut (`Ctrl+Shift+E`) alongside the toolbar
button. Any real invocation works; the shortcut is handy when the icon is not
pinned. On Windows, pin it from the puzzle menu instead.

## Use it

- **hide the arrow** / **hide the panel**: what stays out of the video. Both on
  by default.
- **coach window**: the unrecorded window with the suggestion. On by default.
- **Start recording** asks for the tab-capture stream and starts a `.webm`.
  The toolbar badge reads `REC`.
- **Stop** from the popup or the coach window. Saved to Downloads as
  `chesscan-<timestamp>.webm` (or `.mp4` where the browser only supports that).

Keep the recorded tab visible. A background tab can be throttled by Chrome and
the capture follows the tab's rendering.

## What ends a recording

- pressing Stop;
- closing the recorded tab;
- navigating the recorded tab (the hide style would not exist on the new page);
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
`suggested_key` is applied at install time. It asserts the tab hides, the coach
shows a move, and a playable file lands in Downloads. `puppeteer-core` is the
only dependency.

If the popup does not attach over CDP, the test falls back to clicking the Start
button by coordinates, so it checks the flow rather than Chrome's popup plumbing.

For driving the popup from a script, append `?tab=<tabId>` to `popup.html` — it
uses that tab instead of the active one. That path cannot capture, because it is
not a real invocation.

## Files

| file | job |
| --- | --- |
| `src/background.js` | state, tab-capture handshake, hide style, coach window, download |
| `src/offscreen.js` | `getUserMedia` on the capture stream, `MediaRecorder`, blob URL |
| `src/content.js` | hides chesscan's layers, mirrors the panel text |
| `src/popup.html/js` | start/stop, options, timer |
| `src/coach.html/js` | the unrecorded suggestion window |

## Not built

Whole-screen capture (`chrome.desktopCapture`) instead of the tab. It needs a
picker and a different stream constraint, and it still cannot hide an overlay
from the capture while showing it to you. The coach-window split is what makes
this work; screen-vs-tab is a smaller change on top.

Audio: the tab's sound is left alone on purpose. Adding system audio needs
`getDisplayMedia` and a picker, which changes the permission story.