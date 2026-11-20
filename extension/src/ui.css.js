export const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.panel {
  position: fixed;
  width: 318px;
  background: rgba(19, 21, 25, 0.96);
  border: 1px solid #2b2f36;
  border-radius: 10px;
  color: #e7e8ea;
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
.panel[hidden], .pill[hidden] { display: none; }

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 10px;
  cursor: grab;
  border-bottom: 1px solid #23262c;
}
.head:active { cursor: grabbing; }
.grip { color: #6d737c; font-size: 12px; line-height: 1; }
.brand { font-weight: 600; letter-spacing: 0.02em; }
.site {
  color: #7d838c;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.live {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: #3a3e46;
  flex: none;
}
.live.on { background: #d7b061; animation: cs-pulse 1.1s ease-in-out infinite; }
@keyframes cs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.prob {
  margin-left: auto;
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #c9cdd4;
  min-width: 34px;
  text-align: right;
}

.body { display: block; }
.panel[data-collapsed="true"] .body { display: none; }

.eval { position: relative; height: 6px; background: #2a2d33; }
.eval .fill {
  display: block; height: 100%;
  background: #e8e9ec;
  width: 50%;
  transition: width 0.18s ease-out;
}
.eval .mid {
  position: absolute; left: 50%; top: -2px; bottom: -2px;
  width: 1px; background: #4a4e57;
}

.lines { margin: 0; padding: 6px 0; list-style: none; }
.line {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: baseline;
  padding: 5px 10px;
  border-left: 2px solid transparent;
}
.line.best { border-left-color: #d7b061; background: rgba(215, 176, 97, 0.06); }
.line .san {
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #d5d8dc;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.line.best .san { color: #eceef0; }
.line .sc {
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #9aa0a8;
  min-width: 44px; text-align: right;
}
.line.best .sc { color: #d7b061; }
.line.placeholder { color: #6d737c; grid-template-columns: 1fr; }

.status { padding: 0 10px 7px; color: #d98c8c; font-size: 11px; }
.status:empty { display: none; }

.fen {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid #23262c;
}
.fen code {
  flex: 1;
  font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #9aa0a8;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.bar {
  display: flex; align-items: center; gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid #23262c;
}
.bar .spacer { flex: 1; }
.eng { color: #6d737c; font-size: 10px; white-space: nowrap; }

.btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa0a8;
  font: inherit;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
}
.btn:hover { color: #e7e8ea; background: #23262c; }
.btn:focus-visible { outline: 2px solid #d7b061; outline-offset: 1px; }
.btn[aria-pressed="true"] { color: #d7b061; border-color: #4a3f26; }
.btn.icon { padding: 2px 5px; font-size: 13px; line-height: 1; }
.btn b { font-weight: 600; color: inherit; }

.depth { display: inline-flex; align-items: center; gap: 3px; color: #9aa0a8; font-size: 11px; padding: 0 2px; }
.depth select {
  appearance: none;
  background: #23262c;
  border: 1px solid #2b2f36;
  border-radius: 5px;
  color: #c9cdd4;
  font: inherit;
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
}
.depth select:focus-visible { outline: 2px solid #d7b061; outline-offset: 1px; }

.pill {
  position: fixed;
  right: 16px; bottom: 16px;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(19, 21, 25, 0.96);
  border: 1px solid #2b2f36;
  color: #c9cdd4;
  font: 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
}
.pill:hover { color: #eceef0; border-color: #3a3f48; }
.pill:focus-visible { outline: 2px solid #d7b061; outline-offset: 2px; }
.pill .dot { width: 5px; height: 5px; border-radius: 50%; background: #d7b061; }

@media (prefers-reduced-motion: reduce) {
  .eval .fill { transition: none; }
  .live.on { animation: none; }
}
`;