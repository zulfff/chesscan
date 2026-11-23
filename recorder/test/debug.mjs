import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
const game = (await browser.pages()).find(p => /chess\.com/.test(p.url()));
const coach = (await browser.pages()).find(p => p.url().includes("/src/coach.html"));
if (!game || !coach) {
  console.log("missing page", !!game, !!coach);
  await browser.disconnect();
  process.exit(1);
}

const dump = async label =>
  console.log(
    label,
    JSON.stringify(
      await coach.evaluate(() => ({
        move: document.getElementById("move").textContent,
        squares: document.querySelectorAll("#grid span").length,
        first: [...document.querySelectorAll("#grid span")][0].dataset.square,
        last: [...document.querySelectorAll("#grid span")].at(-1).dataset.square,
        line: (() => {
          const l = document.querySelector("#arrow line");
          return l ? `${l.getAttribute("x1")},${l.getAttribute("y1")} -> ${l.getAttribute("x2")},${l.getAttribute("y2")}` : "none";
        })(),
        hint: document.getElementById("hint").textContent,
      })),
    ),
  );

const flip = () =>
  game.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "Flip Board");
    if (!btn) return false;
    btn.click();
    return true;
  });

await dump("normal:   ");
console.log("flip clicked:", await flip());
await new Promise(r => setTimeout(r, 1500));
await dump("flipped:  ");

// Restore so the board is left as found.
await flip();
await browser.disconnect();