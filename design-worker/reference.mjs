// Capturing a whole reference site, and checking a built site against it.
// Both run the same measurement (capture.mjs) at every width, so the two
// sides of the check are always measured the same way.
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIT_ORIGIN, measurePage, publicUrl } from "./capture.mjs";
import { VIEWPORT_NAMES, auditSite, encodePng, pairImage, regionMask, repairNotes, REGIONS } from "./layout.mjs";
import { referencePrompt } from "./spec.mjs";

export const FORMAT = "forge-measured-v1";

// ai-site-cloner's crawl proposes the start page and the nav pages and skips
// legal and utility pages; its default is about ten pages.
const MOST_PAGES = 10;
const UTILITY = /(^|\/)(privacy|terms|cookie|cookies|legal|accessibility|sitemap|login|log-in|signin|sign-in|signup|sign-up|register|account|my-account|cart|basket|checkout|admin|wp-admin|wp-login|feed|rss|search|tag|category|author)(\/|$|[-_.])/i;
const FILE = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mov|xml|ico|txt|docx?|xlsx?)$/i;

// The same address rules as convex/pages.ts, so a route here and a page there
// are the same string.
export function normalizePath(raw) {
  let value = (raw ?? "/").trim();
  if (!value) return "/";
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.toLowerCase().replace(/\/+/g, "/").replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (!value || value === "/") return "/";
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return value;
}

// The home page and the header's own pages, in the order the header lists them.
export function chooseRoutes(homeUrl, links) {
  const home = new URL(homeUrl);
  const host = home.hostname.replace(/^www\./, "");
  const chosen = [{ path: "/", url: home.href }];
  for (const href of links) {
    if (chosen.length >= MOST_PAGES) break;
    const url = publicUrl(href);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.hostname.replace(/^www\./, "") !== host) continue;
    if (FILE.test(parsed.pathname) || UTILITY.test(parsed.pathname)) continue;
    const routePath = normalizePath(parsed.pathname);
    if (!routePath || routePath === "/" || chosen.some((route) => route.path === routePath)) continue;
    parsed.hash = "";
    parsed.search = "";
    chosen.push({ path: routePath, url: parsed.href });
  }
  return chosen;
}

async function inPool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

async function shotsFor(dir, name) {
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

// The reference: every chosen route at every width. The home page must be
// measured at every width or there is no reference at all; another page that
// cannot be loaded is left out of the routes rather than half-measured.
export async function captureReference(browser, homeUrl, { emit = () => {}, artifacts = null, concurrency = 2 } = {}) {
  emit("inspecting", { page: 1, total: 1 });
  const first = await measurePage(browser, homeUrl, "desktop", { discover: true, shots: await shotsFor(artifacts, "home-desktop") });
  const routes = chooseRoutes(homeUrl, first.links);
  const jobs = [];
  for (const [index, route] of routes.entries()) {
    for (const name of VIEWPORT_NAMES) {
      if (index === 0 && name === "desktop") continue;
      jobs.push({ route, name, index });
    }
  }
  const measured = new Map([[`0:desktop`, first]]);
  let done = 0;
  await inPool(jobs, concurrency, async ({ route, name, index }) => {
    const slug = route.path === "/" ? "home" : route.path.slice(1).replace(/[^a-z0-9]+/g, "-");
    try {
      measured.set(`${index}:${name}`, await measurePage(browser, route.url, name, { shots: await shotsFor(artifacts, `${slug}-${name}`) }));
    } catch (error) {
      measured.set(`${index}:${name}`, { error: String(error?.message ?? error).slice(0, 200) });
    }
    done += 1;
    if (done % VIEWPORT_NAMES.length === 0) emit("inspecting", { page: Math.min(routes.length, 1 + Math.floor(done / VIEWPORT_NAMES.length)), total: routes.length });
  });
  const kept = [];
  for (const [index, route] of routes.entries()) {
    const viewports = Object.fromEntries(VIEWPORT_NAMES.map((name) => [name, measured.get(`${index}:${name}`)]));
    const whole = VIEWPORT_NAMES.every((name) => viewports[name] && !viewports[name].error);
    if (!whole) {
      if (index === 0) throw new Error(`The reference home page could not be measured at every width (${VIEWPORT_NAMES.filter((name) => viewports[name]?.error).join(", ")})`);
      continue;
    }
    for (const name of VIEWPORT_NAMES) delete viewports[name].links;
    kept.push({ path: route.path, url: route.url, viewports });
  }
  emit("measuring", { pages: kept.length });
  const reference = { format: FORMAT, source: homeUrl, capturedAt: new Date().toISOString(), routes: kept };
  return { reference, prompt: referencePrompt(reference) };
}

// forge-image asks are made after the check, so a picture the page asks for is
// stood in by an empty image of the same aspect ratio -- the same box the
// finished picture will fill.
const ASPECTS = { "1:1": [1, 1], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3], "16:9": [16, 9], "9:16": [9, 16] };
function standIn(aspect) {
  const [w, h] = ASPECTS[aspect] ?? ASPECTS["16:9"];
  const width = 1600;
  const height = Math.round((width * h) / w);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#8a8a8a"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
export function withStandIns(html) {
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = src ? (src[1] ?? src[2] ?? "") : "";
      if (!/^forge-image:/i.test(value) && !/\sdata-forge-image\s*=/i.test(tag)) return tag;
      const aspect = /\sdata-forge-aspect\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const replacement = standIn(aspect ? (aspect[1] ?? aspect[2]) : "16:9");
      return src ? tag.replace(src[0], ` src="${replacement}"`) : tag.replace(/^<img\b/i, `<img src="${replacement}"`);
    })
    .replace(/url\(\s*['"]?forge-image:[^)]*\)/gi, `url(${standIn("16:9")})`);
}

// The check: each of the site's routes, served from the audit origin, at
// every width, against the reference.
export async function auditBuild(browser, reference, pages, { emit = () => {}, artifacts = null, concurrency = 2 } = {}) {
  const served = new Map();
  for (const page of pages) {
    const key = normalizePath(page.path);
    if (key) served.set(key, withStandIns(page.html));
  }
  const serve = (pathname) => served.get(normalizePath(pathname) ?? "") ?? null;
  const refPaths = reference.routes.map((route) => route.path);
  const toMeasure = [...served.keys()].filter((key) => refPaths.includes(key));
  const jobs = toMeasure.flatMap((key) => VIEWPORT_NAMES.map((name) => ({ key, name })));
  const measured = new Map();
  let done = 0;
  await inPool(jobs, concurrency, async ({ key, name }) => {
    const slug = key === "/" ? "home" : key.slice(1).replace(/[^a-z0-9]+/g, "-");
    try {
      measured.set(`${key}:${name}`, await measurePage(browser, `${AUDIT_ORIGIN}${key}`, name, { serve, shots: await shotsFor(artifacts, `site-${slug}-${name}`) }));
    } catch (error) {
      measured.set(`${key}:${name}`, { error: String(error?.message ?? error).slice(0, 200) });
    }
    done += 1;
    emit("rendering", { done, total: jobs.length });
  });
  const candidate = {
    routes: [...served.keys()].map((key) => ({
      path: key,
      viewports: Object.fromEntries(VIEWPORT_NAMES.filter((name) => measured.has(`${key}:${name}`)).map((name) => [name, measured.get(`${key}:${name}`)])),
    })),
  };
  emit("comparing", { routes: candidate.routes.length });
  const result = auditSite(reference, candidate);
  const fixes = repairNotes(reference, candidate, result);
  if (artifacts) await writeMaskPairs(artifacts, reference, candidate, result);
  return { ...compact(result), fixes };
}

// Scores without the row maps, which only the fixes needed.
function compact(result) {
  return {
    passed: result.passed,
    routes: result.routes.map((route) => ({
      path: route.path,
      passed: route.passed,
      ...(route.problem ? { problem: route.problem } : {}),
      viewports: Object.fromEntries(Object.entries(route.viewports).map(([name, outcome]) => [name, outcome.regions
        ? {
            passed: outcome.passed,
            regions: Object.fromEntries(REGIONS.map((region) => {
              const r = outcome.regions[region];
              return [region, { score: r.score, threshold: r.threshold, passed: r.passed, heights: r.heights, ...(r.reason ? { reason: r.reason } : {}), bands: r.bands }];
            })),
          }
        : { passed: false, problem: outcome.problem }])),
    })),
  };
}

// A reference|site image of every region's masks, for checking a run by eye.
export async function writeMaskPairs(dir, reference, candidate, result) {
  for (const route of result.routes) {
    const refRoute = reference.routes.find((item) => item.path === route.path);
    const candRoute = candidate.routes.find((item) => item.path === route.path);
    if (!refRoute || !candRoute) continue;
    for (const name of VIEWPORT_NAMES) {
      const refPage = refRoute.viewports[name];
      const candPage = candRoute.viewports[name];
      if (!refPage || !candPage || candPage.error) continue;
      for (const region of REGIONS) {
        const image = pairImage(regionMask(refPage, region, name), regionMask(candPage, region, name));
        if (!image.width || !image.height) continue;
        const slug = route.path === "/" ? "home" : route.path.slice(1).replace(/[^a-z0-9]+/g, "-");
        await fs.writeFile(path.join(dir, `mask-${slug}-${name}-${region}.png`), await encodePng(image));
      }
    }
  }
}
