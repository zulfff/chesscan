// Background entry.
// Firefox event page: a real window, so it hosts the engine itself.
// Chrome service worker: no Worker constructor, so it routes engine work to an
// offscreen document that hosts the engine.

import { createEngineHost } from "./host.js";
import { startRouter } from "./router.js";

const canHost = typeof Worker !== "undefined";

// The router captures this handle; in Firefox it is wired to a local host once
// the router's deliver function exists.
const host = canHost ? { handle: () => {} } : null;
const router = startRouter({ host });

if (canHost) {
  const engineHost = createEngineHost({ deliver: router.deliver });
  host.handle = engineHost.handle;
}