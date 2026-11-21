// Manual probe: what does the live chess.com board actually listen for, and
// does it accept a synthetic click? It plays 1.e4 on whatever board is open,
// so point it at an analysis board. Not part of npm test.
//
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//   node test/probe-synthetic.mjs
import puppeteer from "puppeteer-core";

const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
const page = (await b.pages()).find(p => /chess\.com/.test(p.url()));
await page.bringToFront();
const client = await page.createCDPSession();

async function listenersOf(selector) {
  const { root } = await client.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return { selector, missing: true };
  const { object } = await client.send("DOM.resolveNode", { nodeId });
  const { listeners } = await client.send("DOMDebugger.getEventListeners", {
    objectId: object.objectId,
    depth: 0,
  });
  return {
    selector,
    listeners: listeners.map(l => `${l.type}${l.useCapture ? "(capture)" : ""}${l.passive ? "(passive)" : ""}`),
  };
}

for (const sel of ["wc-chess-board", "chess-board", ".piece", ".board", "wc-chess-board .element-pool"]) {
  console.log(JSON.stringify(await listenersOf(sel)));
}

// Does a synthetic pointer click move the board? Try it on e2-e4 from the start.
const before = await page.evaluate(() => {
  const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
  return s?.getElementById("fen")?.textContent ?? null;
});
console.log("fen before:", before);

const res = await page.evaluate(() => {
  const board = document.querySelector("wc-chess-board, chess-board");
  const r = board.getBoundingClientRect();
  const size = r.width / 8;
  const pt = (file, rank) => ({
    x: r.left + (file + 0.5) * size,
    y: r.top + (7 - rank + 0.5) * size,
  });
  const fire = (el, type, x, y, buttons, Ctor) => {
    el.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: type.endsWith("move") ? -1 : 0, buttons,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
    }));
  };
  const click = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return "no element";
    const tag = el.tagName + "." + el.className;
    fire(el, "pointermove", x, y, 0, PointerEvent);
    fire(el, "mousemove", x, y, 0, MouseEvent);
    fire(el, "pointerdown", x, y, 1, PointerEvent);
    fire(el, "mousedown", x, y, 1, MouseEvent);
    fire(el, "pointerup", x, y, 0, PointerEvent);
    fire(el, "mouseup", x, y, 0, MouseEvent);
    fire(el, "click", x, y, 0, MouseEvent);
    return tag;
  };
  const a = pt(4, 1); // e2
  const c = pt(4, 3); // e4
  return { from: click(a.x, a.y), to: click(c.x, c.y) };
});
console.log("dispatched on:", JSON.stringify(res));
await new Promise(r => setTimeout(r, 2500));
const after = await page.evaluate(() => {
  const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
  return s?.getElementById("fen")?.textContent ?? null;
});
console.log("fen after :", after);
console.log("moved     :", before !== after);
await page.screenshot({ path: "/data/home/probe-synthetic.png" });
await b.disconnect();
