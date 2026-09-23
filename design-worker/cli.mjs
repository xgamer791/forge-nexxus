#!/usr/bin/env node
// Run the capture and the layout check by hand, outside the server.
//
//   node cli.mjs capture <reference-url> --out <dir>
//     Measures the reference at phone, tablet and desktop widths and writes
//     <dir>/reference.json, <dir>/prompt.txt and a screenshot per page, width
//     and opened menu. No search is made: the address given is the reference.
//
//   node cli.mjs audit --reference <dir>/reference.json --site <built-site-url> --out <dir>
//       [--map /=/ --map /cater=/catering ...]
//     Measures a published site the same way and checks it against the
//     reference: every route, every width, full page, header, menu, body and
//     footer. Each --map pairs a reference route with the site's route; with
//     none, every reference route is looked for at the same path. Writes
//     <dir>/audit.json, the fixes a failed check would send back, the site's
//     screenshots and a reference|site mask image per region.
//
//   node cli.mjs audit --reference <ref.json> --pages <dir-of-html> --out <dir>
//     The server's path: each <route>.html in the folder (index.html is /) is
//     served from the audit origin, forge-image asks and all.
//
// Browser options for machines where Chromium is not Playwright's own:
//   --executable <chromium>  --proxy <url>  --trust-spki <sha256-base64>
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { measurePage } from "./capture.mjs";
import { VIEWPORT_NAMES, auditSite, repairNotes } from "./layout.mjs";
import { auditBuild, captureReference, normalizePath, writeMaskPairs } from "./reference.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[key] = key in out ? [].concat(out[key], value) : value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [command, target] = args._;
const out = typeof args.out === "string" ? args.out : "forge-design-out";
const launch = { headless: true };
if (typeof args.executable === "string") launch.executablePath = args.executable;
if (typeof args.proxy === "string") launch.proxy = { server: args.proxy };
if (typeof args["trust-spki"] === "string") launch.args = [`--ignore-certificate-errors-spki-list=${args["trust-spki"]}`];
const log = (phase, detail) => console.error(`  ${phase} ${JSON.stringify(detail)}`);

if (command === "capture" && target) {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch(launch);
  const t0 = Date.now();
  try {
    const { reference, prompt } = await captureReference(browser, target, { emit: log, artifacts: path.join(out, "shots") });
    await fs.writeFile(path.join(out, "reference.json"), JSON.stringify(reference));
    await fs.writeFile(path.join(out, "prompt.txt"), prompt);
    console.log(JSON.stringify({
      seconds: Math.round((Date.now() - t0) / 1000),
      routes: reference.routes.map((route) => ({
        path: route.path,
        heights: Object.fromEntries(VIEWPORT_NAMES.map((name) => [name, route.viewports[name].height])),
        sections: Object.fromEntries(VIEWPORT_NAMES.map((name) => [name, route.viewports[name].sections.length])),
        menu: Object.fromEntries(VIEWPORT_NAMES.map((name) => [name, route.viewports[name].menu.opened ? `${route.viewports[name].menu.links} links` : "none"])),
      })),
      referenceBytes: JSON.stringify(reference).length,
      promptChars: prompt.length,
    }, null, 2));
  } finally {
    await browser.close();
  }
} else if (command === "audit" && typeof args.reference === "string") {
  await fs.mkdir(out, { recursive: true });
  const reference = JSON.parse(await fs.readFile(args.reference, "utf8"));
  const browser = await chromium.launch(launch);
  const t0 = Date.now();
  try {
    let result;
    if (typeof args.pages === "string") {
      const pages = [];
      for (const file of await fs.readdir(args.pages)) {
        if (!file.endsWith(".html")) continue;
        const route = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`;
        pages.push({ path: route, html: await fs.readFile(path.join(args.pages, file), "utf8") });
      }
      result = await auditBuild(browser, reference, pages, { emit: log, artifacts: out });
    } else if (typeof args.site === "string") {
      const site = args.site.replace(/\/+$/, "");
      const pairs = [].concat(args.map ?? []).map((pair) => String(pair).split("="));
      const mapping = pairs.length ? pairs : reference.routes.map((route) => [route.path, route.path]);
      // With pairs given, only those reference routes are checked.
      const scoped = pairs.length
        ? { ...reference, routes: reference.routes.filter((route) => mapping.some(([ref]) => normalizePath(ref) === route.path)) }
        : reference;
      const candidate = { routes: [] };
      for (const [ref, mine] of mapping) {
        const viewports = {};
        for (const name of VIEWPORT_NAMES) {
          const route = normalizePath(ref) ?? "/";
          const slug = `${route === "/" ? "home" : route.slice(1).replace(/[^a-z0-9]+/g, "-")}-${name}`;
          try {
            viewports[name] = await measurePage(browser, `${site}${mine === "/" ? "/" : mine}`, name, { shots: path.join(out, `site-${slug}`) });
          } catch (error) {
            viewports[name] = { error: String(error?.message ?? error) };
          }
          log("measured", { route: ref, width: name });
        }
        candidate.routes.push({ path: normalizePath(ref), viewports });
      }
      const audit = auditSite(scoped, candidate);
      result = { passed: audit.passed, routes: audit.routes, fixes: repairNotes(scoped, candidate, audit) };
      await writeMaskPairs(out, scoped, candidate, audit);
    } else {
      throw new Error("audit needs --site <url> or --pages <dir>");
    }
    const table = [];
    for (const route of result.routes) {
      if (route.problem) {
        table.push(`${route.path.padEnd(14)} ${route.problem.toUpperCase()}`);
        continue;
      }
      for (const name of VIEWPORT_NAMES) {
        const outcome = route.viewports[name];
        if (!outcome?.regions) {
          table.push(`${route.path.padEnd(14)} ${name.padEnd(8)} NOT MEASURED ${outcome?.problem ?? ""}`);
          continue;
        }
        const cells = Object.entries(outcome.regions).map(([region, r]) => `${region} ${(r.score * 100).toFixed(1)}%${r.passed ? "" : "✗"}`);
        table.push(`${route.path.padEnd(14)} ${name.padEnd(8)} ${cells.join("  ")}`);
      }
    }
    await fs.writeFile(path.join(out, "audit.json"), JSON.stringify(result, (key, value) => (key === "rowMap" ? undefined : value), 2));
    console.log(`${result.passed ? "PASSED" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s\n${table.join("\n")}\n\nFixes:\n${result.fixes.join("\n")}`);
    process.exitCode = result.passed ? 0 : 1;
  } finally {
    await browser.close();
  }
} else {
  console.error("Usage: node cli.mjs capture <url> --out <dir>\n       node cli.mjs audit --reference <reference.json> (--site <url> [--map ref=site ...] | --pages <dir>) --out <dir>");
  process.exitCode = 2;
}
