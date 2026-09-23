// The page discovery agent: which of the reference site's pages a build
// clones. It opens the reference's home page, reads the links its header and
// navigation carry -- the desktop row and the phone menu alike, in the order
// the site lists them -- and keeps the home page and the site's own
// destinations: never a legal, account, cart, search or feed page, never a
// file, never another host. Five pages at most, the home page first. The
// footer's links only fill the list when the header has too few.
//
// The builders write exactly these pages, one at a time, and SkillUI Ultra
// extracts the design they are built to (skillui.mjs).

export const MAX_PAGES = 5;

const BLOCKED = /(?:^|\.)(?:localhost|local|internal|test)$/i;
const UTILITY = /(^|\/)(privacy|terms|cookie|cookies|legal|accessibility|sitemap|login|log-in|signin|sign-in|signup|sign-up|register|account|my-account|cart|basket|checkout|admin|wp-admin|wp-login|feed|rss|search|tag|category|author)(\/|$|[-_.])/i;
const FILE = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mov|xml|ico|txt|json|css|js|docx?|xlsx?)$/i;

// A public http(s) address, or null. The browser may load nothing else.
export function publicUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) return null;
    if (BLOCKED.test(host) || host === "localhost" || host === "0.0.0.0" || host === "::1" ||
        /^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^(?:fc|fd|fe80)/i.test(host) || !host.includes(".")) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

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

// The home page, then each link that names one of the site's own pages, in
// the order given, until there are MAX_PAGES.
export function chooseRoutes(homeUrl, links, most = MAX_PAGES) {
  const home = new URL(homeUrl);
  const host = home.hostname.replace(/^www\./, "");
  const chosen = [{ path: "/", url: home.origin + "/" }];
  for (const href of links) {
    if (chosen.length >= most) break;
    const url = publicUrl(href);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.hostname.replace(/^www\./, "") !== host) continue;
    if (FILE.test(parsed.pathname) || UTILITY.test(parsed.pathname)) continue;
    const path = normalizePath(parsed.pathname);
    if (!path || path === "/" || chosen.some((route) => route.path === path)) continue;
    parsed.hash = "";
    parsed.search = "";
    chosen.push({ path, url: parsed.href });
  }
  return chosen;
}

// Read in the page: the links of the header and navigation first, then the
// footer's. Hidden links count -- a phone menu is closed until it is opened --
// and so do links outside any landmark only when nothing else names a page.
function linksInPage() {
  const hrefs = (selector) => [...document.querySelectorAll(selector)].map((a) => a.href).filter(Boolean);
  const chrome = hrefs("header a[href], [role=banner] a[href], nav a[href], [role=navigation] a[href]");
  const footer = hrefs("footer a[href], [role=contentinfo] a[href]");
  const rest = chrome.length + footer.length ? [] : hrefs("a[href]").slice(0, 60);
  return [...chrome, ...footer, ...rest];
}

// The agent itself: the reference's pages, home first, five at most. A home
// page that will not load is no reference at all.
export async function discoverPages(browser, homeUrl, { emit = () => {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => (publicUrl(route.request().url()) ? route.continue() : route.abort()));
    const response = await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response || response.status() >= 400 || !publicUrl(page.url())) throw new Error("The reference home page could not be loaded");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const links = await page.evaluate(linksInPage);
    const routes = chooseRoutes(page.url(), links);
    emit("discovering", { pages: routes.length });
    return routes;
  } finally {
    await context.close();
  }
}
