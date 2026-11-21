// Sanity check for humanize.js. Run: node tools/humanize-check.mjs
import { Humanizer, SKILL, temperature, cpCeiling, thinkTime } from "../extension/src/humanize.js";

const cp = v => ({ type: "cp", value: v });
const lines = (vals, depth) =>
  vals.map((v, i) => ({ multipv: i + 1, depth, score: cp(v), pv: [`move${i}`] }));

function run(skill, shallow, deep, trials = 20000) {
  const h = new Humanizer({ ...SKILL[skill], rng: Math.random });
  const turn = "w";
  const counts = {};
  const reasons = {};
  let cpSum = 0;
  for (let i = 0; i < trials; i++) {
    h.reset();
    h.observe(lines(shallow, 4), turn);
    h.observe(lines(deep, 16), turn);
    const pick = h.choose(lines(deep, 16), turn);
    counts[pick.uci] = (counts[pick.uci] || 0) + 1;
    reasons[pick.reason] = (reasons[pick.reason] || 0) + 1;
    cpSum += pick.cpLoss;
  }
  const dist = Object.entries(counts)
    .map(([k, v]) => `${k}:${((v / trials) * 100).toFixed(1)}%`)
    .join(" ");
  console.log(`${skill.padEnd(11)} meanCpLoss=${(cpSum / trials).toFixed(1)}  ${dist}`);
  console.log(`${"".padEnd(11)} ${JSON.stringify(reasons)}`);
}

console.log("== quiet position: 0.40 0.25 0.05 -0.30 ==");
for (const s of Object.keys(SKILL)) run(s, [40, 25, 5, -30], [40, 25, 5, -30]);

console.log("\n== sharp position: 1.20 -0.50 -3.00 ==");
for (const s of Object.keys(SKILL)) run(s, [120, -50, -300], [120, -50, -300]);

console.log("\n== brilliancy: move1 looks bad shallow, wins deep ==");
run("expert", [120, -20], [60, 260], 20000);

console.log("\n== blunder bait: move1 looks best shallow, loses deep ==");
run("club", [180, 40], [180, -140], 20000);

console.log("\n== forced ==");
const h = new Humanizer(SKILL.master);
console.log(h.choose(lines([50], 16), "w"));

console.log("\n== calibration ==");
for (const elo of [800, 1200, 1600, 2000, 2400]) {
  console.log(`elo ${elo}: T=${temperature(elo).toFixed(4)} cpCeiling=${cpCeiling(elo).toFixed(0)}`);
}

console.log("\n== think time (ms), branching 30 ==");
for (const instability of [0, 0.15, 0.4]) {
  const xs = [];
  for (let i = 0; i < 2000; i++) xs.push(thinkTime({ elo: 1500, branching: 30, instability }));
  xs.sort((a, b) => a - b);
  console.log(
    `instability ${instability}: min ${xs[0]} p50 ${xs[1000]} p95 ${xs[1900]} max ${xs[1999]}`
  );
}
console.log("forced:", thinkTime({ forced: true }));