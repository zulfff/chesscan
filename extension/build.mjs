// Bundles the scripts and vendors the Stockfish WASM build, then writes two
// load-unpacked folders: build/chrome and build/firefox.
import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const engineDir = join(dist, "engine");

const ENGINE_JS = "stockfish-19-lite-single.js";
// The glue derives the wasm name from its own filename, so it must match.
const ENGINE_WASM = "stockfish-19-lite-single.wasm";

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(engineDir, { recursive: true });

  await build({
    entryPoints: [
      join(root, "src/content.js"),
      join(root, "src/background.js"),
      join(root, "src/offscreen.js"),
    ],
    bundle: true,
    format: "iife",
    outdir: dist,
    target: ["chrome110", "firefox115"],
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });

  const pkg = join(root, "node_modules/stockfish/bin");
  await copyFile(join(pkg, ENGINE_JS), join(engineDir, ENGINE_JS));
  await copyFile(join(pkg, "stockfish-19-lite-single.wasm"), join(engineDir, ENGINE_WASM));
  await copyFile(join(root, "src/offscreen.html"), join(dist, "offscreen.html"));

  for (const [target, manifestFile] of [
    ["chrome", "manifest.json"],
    ["firefox", "manifest.firefox.json"],
  ]) {
    const out = join(root, "build", target);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    await cp(dist, join(out, "dist"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, manifestFile), "utf8"));
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`build/${target}/ ready`);
  }

  for (const f of ["content.js", "background.js", "offscreen.js", `engine/${ENGINE_JS}`, `engine/${ENGINE_WASM}`]) {
    const s = await stat(join(dist, f));
    console.log(`${f.padEnd(40)} ${(s.size / 1024).toFixed(1)} kB`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});