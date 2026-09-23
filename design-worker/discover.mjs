// Page discovery. Finds the homepage and the pages linked from its header,
// nav and footer, and stops at five. It does not measure layout and it does
// not score a clone.
import { publicUrl } from "./urls.mjs";

export const MAX_PAGES = 5;

const UTILITY = /(^|\/)(privacy|terms|cookie|cookies|legal|accessibility|sitemap|login|log-in|signin|sign-in|signup|sign-up|register|account|my-account|cart|basket|checkout|admin|wp-admin|wp-login|feed|rss|search|tag|category|author)(\/|$|[-_.])/i;
const FILE = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mov|xml|ico|txt|docx?|xlsx?)$/i;

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

// Home first, then header and footer links in the order they appear, skipping
// utility and file links. Never more than MAX_PAGES.
export function chooseRoutes(homeUrl, links) {
  const home = new URL(homeUrl);
  const host = home.hostname.replace(/^www\./, "");
  const chosen = [{ path: "/", url: home.href }];
  for (const href of links) {
    if (chosen.length >= MAX_PAGES) break;
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

// The discovery pass: one homepage load, the links in the shell, then the
// capped route list. The browser is the caller's; SkillUI opens its own later.
export async function discoverRoutes(browser, homeUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => (publicUrl(route.request().url()) ? route.continue() : route.abort()));
    const response = await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (!response || response.status() >= 400) throw new Error("The reference home page could not be opened");
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("header a, nav a, footer a")].map((anchor) => anchor.href).filter(Boolean),
    );
    return chooseRoutes(page.url(), links);
  } finally {
    await context.close();
  }
}
