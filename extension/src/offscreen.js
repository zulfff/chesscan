// Offscreen document entry (Chrome): an engine host with the DOM/worker context
// a service worker cannot provide. Replies go back to the background router.
import { createEngineHost } from "./host.js";

const ext = globalThis.browser ?? globalThis.chrome;

const host = createEngineHost({
  deliver: payload => {
    try {
      const p = ext.runtime.sendMessage({ ...payload, target: "sw" });
      p?.catch?.(() => {});
    } catch {
      /* no receiver */
    }
  },
});

ext.runtime.onMessage.addListener(msg => {
  if (msg && typeof msg === "object" && msg.target === "engine") host.handle(msg);
});