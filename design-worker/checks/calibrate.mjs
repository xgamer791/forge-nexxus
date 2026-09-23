#!/usr/bin/env node
// How the layout check's thresholds were set, on the one pair named for it:
// tacosinplano.com as the reference and the El Farolito draft built from it.
// It needs the network and a browser, so `npm test` does not run it:
//
//   node checks/calibrate.mjs --reference <reference.json> [--out <dir>]
//       [--executable <chromium>] [--proxy <url>] [--trust-spki <sha256-base64>]
//
// Four fixtures, each measured exactly as the check measures a built site:
//   self     the reference again: how steady the measurement is
//   restyle  the reference with every word swapped for others of about the
//            same length and every font replaced: a faithful build's layout
//   chrome   the reference home with its body swapped for generic editorial
//            sections, header and footer kept: chrome-only similarity
//   draft    the El Farolito draft, /menu against /food-menu and /catering
//            against /cater
// The thresholds in layout.mjs must pass self and restyle everywhere, fail
// chrome's body, and fail the draft's body and footer.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { measurePage } from "../capture.mjs";
import { REGIONS, THRESHOLDS, VIEWPORT_NAMES, auditSite } from "../layout.mjs";
import { writeMaskPairs } from "../reference.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
}
if (typeof args.reference !== "string") {
  console.error("Usage: node checks/calibrate.mjs --reference <reference.json> [--out <dir>]");
  process.exit(2);
}
const reference = JSON.parse(await fs.readFile(args.reference, "utf8"));
const out = typeof args.out === "string" ? args.out : null;
const launch = { headless: true };
if (typeof args.executable === "string") launch.executablePath = args.executable;
if (typeof args.proxy === "string") launch.proxy = { server: args.proxy };
if (typeof args["trust-spki"] === "string") launch.args = [`--ignore-certificate-errors-spki-list=${args["trust-spki"]}`];

const DRAFT = "https://taqueria-el-farolito-del-rio.sites.forgenexxus.com";

// Every word replaced by letters of about the same length (a fixed seed, so
// every run is the same run), and every font replaced.
const RESTYLE = `<script>(() => {
  let seed = 20260923;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const letters = "etaoinshrdlucmfwypvbgk";
  const swap = (word) => {
    const n = Math.max(1, Math.round(word.length * (0.75 + rnd() * 0.5)));
    let made = "";
    for (let i = 0; i < n; i += 1) made += letters[Math.floor(rnd() * letters.length)];
    return word[0] === word[0].toUpperCase() ? made.toUpperCase().slice(0, 1) + made.slice(1) : made;
  };
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 && child.textContent.trim()) child.textContent = child.textContent.replace(/[A-Za-z]+/g, swap);
      else if (child.nodeType === 1 && !["SCRIPT", "STYLE"].includes(child.tagName)) walk(child);
    }
  };
  const run = () => {
    walk(document.body);
    const style = document.createElement("style");
    style.textContent = "*{font-family:Georgia,'Times New Roman',serif!important}";
    document.head.append(style);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();</script>`;

// The home page's body swapped for four identical editorial splits.
const CHROME = `<script>(() => {
  const run = () => {
    const main = document.querySelector("main");
    if (!main) return;
    const sections = [...main.children].filter((el) => el.tagName !== "H1");
    const keep = sections.at(-1);
    for (const el of sections) if (el !== keep) el.remove();
    document.querySelectorAll("header.header").forEach((el) => el.remove());
    for (let i = 0; i < 4; i += 1) {
      const section = document.createElement("section");
      section.style.cssText = "display:flex;gap:48px;align-items:center;padding:96px 64px;background:#fff;color:#111;" + (i % 2 ? "flex-direction:row-reverse;" : "");
      section.innerHTML = '<div style="flex:1;aspect-ratio:4/3;background:#999"></div><div style="flex:1"><h2 style="font-size:40px;margin:0 0 16px">A heading for this part</h2><p style="font-size:18px;line-height:1.6">A paragraph of ordinary length that sits beside the picture in the way a template would put it, twice over for good measure and a little more.</p><a href="#" style="display:inline-block;padding:12px 20px;border:1px solid #111">See more</a></div>';
      main.insertBefore(section, keep);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();</script>`;

const inject = (script) => (html) => (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : html + script);

async function measureSite(browser, pairs, rewriteFor) {
  const routes = [];
  for (const [refPath, url] of pairs) {
    const viewports = {};
    for (const name of VIEWPORT_NAMES) {
      try {
        viewports[name] = await measurePage(browser, url, name, { rewrite: rewriteFor?.(refPath) ?? null });
      } catch (error) {
        viewports[name] = { error: String(error?.message ?? error) };
      }
    }
    routes.push({ path: refPath, viewports });
  }
  return { routes };
}

const browser = await chromium.launch(launch);
const results = {};
try {
  const own = reference.routes.map((route) => [route.path, route.url]);
  const draftPairs = [["/", `${DRAFT}/`], ["/food-menu", `${DRAFT}/menu`], ["/cater", `${DRAFT}/catering`]];
  const fixtures = {
    self: { pairs: own },
    restyle: { pairs: own, rewrite: () => inject(RESTYLE) },
    chrome: { pairs: own, rewrite: (route) => (route === "/" ? inject(CHROME) : null) },
    draft: { pairs: draftPairs },
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    const scoped = { ...reference, routes: reference.routes.filter((route) => fixture.pairs.some(([p]) => p === route.path)) };
    const candidate = await measureSite(browser, fixture.pairs, fixture.rewrite);
    const audit = auditSite(scoped, candidate);
    results[name] = audit;
    if (out) {
      const dir = path.join(out, name);
      await fs.mkdir(dir, { recursive: true });
      await writeMaskPairs(dir, scoped, candidate, audit);
    }
    console.log(`\n${name.toUpperCase()}: ${audit.passed ? "passes" : "fails"}`);
    for (const route of audit.routes) {
      for (const width of VIEWPORT_NAMES) {
        const outcome = route.viewports[width];
        if (!outcome?.regions) {
          console.log(`  ${route.path.padEnd(11)} ${width.padEnd(8)} not measured: ${outcome?.problem ?? route.problem}`);
          continue;
        }
        const cells = REGIONS.map((region) => {
          const r = outcome.regions[region];
          return `${region} ${(r.score * 100).toFixed(1).padStart(5)}${r.passed ? " " : "✗"}`;
        });
        console.log(`  ${route.path.padEnd(11)} ${width.padEnd(8)} ${cells.join("  ")}`);
      }
    }
  }
} finally {
  await browser.close();
}

// Lowest score each region reached on the fixtures that must pass, highest on
// those that must fail.
const extreme = (name, region, pick) => {
  const scores = results[name].routes.flatMap((route) => VIEWPORT_NAMES.map((width) => route.viewports[width]?.regions?.[region]?.score)).filter((s) => typeof s === "number");
  return scores.length ? pick(...scores) : null;
};
console.log("\nregion   threshold  self(min) restyle(min) chrome(max) draft(max)");
for (const region of REGIONS) {
  const row = [extreme("self", region, Math.min), extreme("restyle", region, Math.min), extreme("chrome", region, Math.max), extreme("draft", region, Math.max)];
  console.log(`${region.padEnd(8)} ${String(THRESHOLDS[region]).padEnd(10)} ${row.map((s) => (s === null ? "-" : (s * 100).toFixed(1)).padEnd(12)).join("")}`);
}
if (out) {
  const scores = Object.fromEntries(Object.entries(results).map(([name, audit]) => [name, {
    passed: audit.passed,
    routes: audit.routes.map((route) => ({
      path: route.path,
      viewports: Object.fromEntries(VIEWPORT_NAMES.map((width) => [width, route.viewports[width]?.regions
        ? Object.fromEntries(REGIONS.map((region) => {
            const r = route.viewports[width].regions[region];
            return [region, { score: r.score, passed: r.passed, heights: r.heights, lowestBand: Math.min(1, ...r.bands.map((band) => band.score)) }];
          }))
        : { problem: route.viewports[width]?.problem ?? route.problem ?? "not measured" }])),
    })),
  }]));
  await fs.writeFile(path.join(out, "calibration.json"), JSON.stringify({ thresholds: THRESHOLDS, fixtures: scores }, null, 2));
}
const bodyOf = (name, route) => results[name].routes.find((r) => r.path === route);
const ok = results.self.passed && results.restyle.passed &&
  VIEWPORT_NAMES.some((width) => bodyOf("chrome", "/")?.viewports[width]?.regions?.body?.passed === false) &&
  results.draft.routes.every((route) => VIEWPORT_NAMES.every((width) => {
    const regions = route.viewports[width]?.regions;
    return !regions || (!regions.body.passed || route.path !== "/") && (route.path !== "/" || VIEWPORT_NAMES.some((w) => route.viewports[w]?.regions?.footer?.passed === false));
  }));
console.log(`\n${ok ? "CALIBRATED" : "NOT CALIBRATED"}: self and restyle ${results.self.passed && results.restyle.passed ? "pass" : "do not all pass"}; chrome body and draft body/footer ${ok ? "fail" : "check the table"}.`);
process.exitCode = ok ? 0 : 1;
