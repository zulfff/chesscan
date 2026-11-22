import puppeteer from "puppeteer-core";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });

let attached = false;
for (let i = 0; i < 40 && !attached; i += 1) {
  const t = browser.targets().find(t => t.type() === "service_worker" && /src\/background\.js/.test(t.url()));
  if (t) {
    const cdp = await t.createCDPSession();
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    cdp.on("Runtime.exceptionThrown", e =>
      console.log("SW EXC:", JSON.stringify(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text)),
    );
    cdp.on("Log.entryAdded", e => console.log("LOG:", e.entry.level, e.entry.text.slice(0, 300)));
    attached = true;
  }
  await sleep(250);
}

for (const pg of await browser.pages()) {
  const url = pg.url();
  if (url.includes("/src/record.html")) {
    console.log(
      "RECORD:",
      JSON.stringify(
        await pg.evaluate(() => ({
          status: document.getElementById("status").textContent,
          time: document.getElementById("time").textContent,
          stopDisabled: document.getElementById("stop").disabled,
          saveHidden: document.getElementById("save").hidden,
        })),
      ),
    );
  }
  if (url.includes("/src/popup.html")) {
    console.log(
      "POPUP:",
      JSON.stringify(
        await pg.evaluate(() => ({
          status: document.getElementById("status").textContent,
          disabled: document.getElementById("go").disabled,
          label: document.getElementById("go").textContent,
        })),
      ),
    );
  }
  if (/chess\.com/.test(url)) {
    console.log(
      "TAB:",
      JSON.stringify(
        await pg.evaluate(() => {
          const host = document.getElementById("chesscan-ext-root");
          const arrow = document.getElementById("chesscan-arrow-layer");
          return {
            panel: host ? getComputedStyle(host).display : "missing",
            arrow: arrow ? getComputedStyle(arrow).display : "missing",
            style: !!document.getElementById("chesscan-rec-hide"),
          };
        }),
      ),
    );
  }
}

const swTarget = browser.targets().find(t => t.type() === "service_worker" && /src\/background\.js/.test(t.url()));
if (swTarget) {
  const worker = await swTarget.worker();
  console.log(
    "STATE:",
    JSON.stringify(await worker.evaluate(async () => (await chrome.storage.session.get("recorder")).recorder ?? null)),
  );
}
await sleep(500);
await browser.disconnect();