// Measured capture: what a page is made of, read from the live page by script.
//
// Adapted from ai-site-cloner (https://github.com/Mahanaicoach/ai-site-cloner,
// MIT, Copyright (c) 2026 Mahanaicoach; see NOTICE):
// - scripts/lib.mjs: the viewports, the settle sequence (load, then network
//   quiet, fonts and images concurrently, then a height that has stopped
//   growing), the half-viewport scroll that wakes lazy content, freezePage
//   (animations parked on their last frame, transitions off, videos paused on
//   a frame with content) and transitionMs.
// - scripts/extract/collectors.mjs: detectSections and the layout signature of
//   measureSections (real column count, the grid's items and gap, padding).
// - scripts/extract/section.mjs: a second state captured after a click and
//   diffed against the first -- here, the navigation opened.
//
// Forge keeps the geometry and drops the content: no text, no image address,
// no colour and no font family leaves the page. What comes back is a list of
// painted boxes by kind (see layout.mjs), the header, footer and sections with
// their measured layout, the type scale by size, and the opened menu.
import { VIEWPORTS } from "./layout.mjs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The origin a candidate site is served from while it is checked. Nothing
// leaves the browser for it: every request to it is answered from the routes
// the check was given.
export const AUDIT_ORIGIN = "https://forge-audit.invalid";

const BLOCKED = /(?:^|\.)(?:localhost|local|internal|test)$/i;

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

// ---------------------------------------------------------------------------
// Waiting -- conditions, not sleeps (ai-site-cloner, scripts/lib.mjs)
// ---------------------------------------------------------------------------

async function settleLayout(page, { timeout = 3000, quietMs = 150 } = {}) {
  await page
    .evaluate(async ({ timeout, quietMs }) => {
      const deadline = Date.now() + timeout;
      let last = -1;
      let stableSince = 0;
      while (Date.now() < deadline) {
        const h = document.documentElement.scrollHeight;
        if (h === last) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= quietMs) return;
        } else {
          last = h;
          stableSince = 0;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, { timeout, quietMs })
    .catch(() => {});
}

async function imagesSettled(page, { timeout = 4000 } = {}) {
  await page
    .evaluate(async (timeout) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const pending = [...document.images].filter((img) => !img.complete);
        if (!pending.length) return;
        await Promise.race([
          Promise.all(pending.map((img) => new Promise((r) => {
            img.addEventListener("load", r, { once: true });
            img.addEventListener("error", r, { once: true });
          }))),
          new Promise((r) => setTimeout(r, 100)),
        ]);
      }
    }, timeout)
    .catch(() => {});
}

async function settle(page) {
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
    page.evaluate(() => document.fonts?.ready).catch(() => {}),
    imagesSettled(page),
  ]);
  await settleLayout(page);
}

// Half-viewport steps to the bottom and back: IntersectionObserver thresholds
// commonly need an element substantially in view.
async function autoScroll(page) {
  await page
    .evaluate(async () => {
      const step = window.innerHeight / 2;
      for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}),
    imagesSettled(page),
  ]);
  await settleLayout(page);
}

// Animations jump to their end state rather than `animation: none`, which
// would revert fill-mode entry animations to their invisible first frame.
async function freeze(page) {
  await page
    .addStyleTag({
      content:
        "*,*::before,*::after{animation-delay:-0.0001s!important;animation-duration:0.0001s!important;" +
        "animation-iteration-count:1!important;transition-delay:0s!important;transition-duration:0s!important;" +
        "caret-color:transparent!important;scroll-behavior:auto!important}",
    })
    .catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await page
    .evaluate(async () => {
      await Promise.all([...document.querySelectorAll("video")].map((v) => new Promise((resolve) => {
        v.pause();
        const target = Number.isFinite(v.duration) && v.duration > 1 ? 1 : 0;
        if (Math.abs(v.currentTime - target) < 0.05) return resolve();
        v.addEventListener("seeked", () => resolve(), { once: true });
        v.currentTime = target;
        setTimeout(resolve, 1000);
      })));
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Normalising what is not the design: a promotion or consent dialog laid over
// the page on load, and content held invisible until it scrolls into view.
// Both sides of every comparison get exactly this.
// ---------------------------------------------------------------------------

function normalizeInPage() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cover = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
    return (w * h) / (W * H);
  };
  const named = /(^|[\s_-])(modal|popup|pop-up|lightbox|overlay|backdrop|cookie|cookies|consent|gdpr|onetrust|interstitial)([\s_-]|$)/i;
  let hidden = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const role = el.getAttribute("role") || "";
    const label = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
    const dialog = (el.localName === "dialog" && el.open) || role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true";
    const pinned = cs.position === "fixed" || cs.position === "sticky";
    if ((dialog && (pinned || cover(el) > 0.3)) || (named.test(label) && pinned && cover(el) > 0.15)) {
      el.style.setProperty("display", "none", "important");
      hidden += 1;
    }
  }
  if (hidden) {
    document.body.classList.remove("modal-open");
    for (const el of [document.documentElement, document.body]) {
      if (getComputedStyle(el).overflowY === "hidden") el.style.setProperty("overflow", "visible", "important");
    }
  }
  if (!document.querySelector("style[data-forge-reveal]")) {
    const style = document.createElement("style");
    style.setAttribute("data-forge-reveal", "");
    style.textContent =
      "[data-aos],.aos-init,.wow,.animate__animated,[data-animate],[data-sal],[data-scroll],.reveal,.fade-in,.fadeIn" +
      "{opacity:1!important;transform:none!important;visibility:visible!important}";
    document.head.append(style);
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// The measurement itself, run inside the page.
// ---------------------------------------------------------------------------

function measureInPage(options) {
  const { viewportOnly = false, discover = false } = options || {};
  window.scrollTo(0, 0);
  const sx = window.scrollX;
  const sy = window.scrollY;
  const W = document.documentElement.clientWidth;
  const VH = window.innerHeight;
  const H = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const LIMIT = viewportOnly ? VH : H;
  const KIND = { surface: 1, media: 2, text: 3, heading: 4, control: 5, mark: 6 };
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "base"]);
  const MEDIA = new Set(["img", "video", "canvas", "iframe", "embed", "object"]);
  const PAGE = { x0: 0, y0: 0, x1: W, y1: LIMIT };

  const color = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (top, under) => {
    if (!under) return { r: top.r, g: top.g, b: top.b };
    return { r: top.a * top.r + (1 - top.a) * under.r, g: top.a * top.g + (1 - top.a) * under.g, b: top.a * top.b + (1 - top.a) * under.b };
  };
  const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  const rectOf = (r) => ({ x0: r.left + sx, y0: r.top + sy, x1: r.right + sx, y1: r.bottom + sy });
  const intersect = (a, b) => {
    const x0 = Math.max(a.x0, b.x0);
    const y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1);
    const y1 = Math.min(a.y1, b.y1);
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < W && r.bottom + sy > 0;
  };
  const px = (value) => Math.round(Number.parseFloat(value) || 0);

  // The page's own ground: the html background, then the body's over it.
  let ground = { r: 255, g: 255, b: 255 };
  for (const el of [document.documentElement, document.body]) {
    const c = el && color(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0.05) ground = blend(c, ground);
  }

  // -- The header: the site's chrome at the top, holding its navigation. A
  // hero that happens to be a <header> is as tall as the screen and is not it.
  const headerSelector = "header, [role=banner], nav, [role=navigation], [id*=header i], [class*=header i], [id*=navbar i], [class*=navbar i], [id*=masthead i], [class*=masthead i]";
  const linkCount = (el) => [...el.querySelectorAll("a[href], button")].filter(shown).length;
  const headerCandidates = [...document.querySelectorAll(headerSelector)].filter((el) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= W * 0.5 && r.height >= 20 && r.height <= VH * 0.6 && r.top + sy <= 150 && linkCount(el) >= 1;
  });
  const outermost = (list) => list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
  const top = (el) => el.getBoundingClientRect().top + sy;
  const bottom = (el) => el.getBoundingClientRect().bottom + sy;
  // The main navigation is the candidate holding the menu button, or else the
  // most links; a hero that happens to be a <header> under it holds neither.
  // Chrome can be more than one bar, so thin strips stacked right above it
  // without a gap are part of it too.
  const toggleWords = /menu|hamburger|burger|navbar-toggle|nav-toggle|toggle|offcanvas|off-canvas|drawer|sidenav|mobile-nav|open-nav|nav-open/i;
  const holdsToggle = (el) => [...el.querySelectorAll("button, [role=button], [aria-expanded], [aria-controls], summary, label[for]")].some((c) => shown(c) &&
    (c.hasAttribute("aria-expanded") || c.hasAttribute("aria-controls") ||
      toggleWords.test([c.getAttribute("aria-label"), c.id, typeof c.className === "string" ? c.className : "", c.getAttribute("data-toggle"), c.getAttribute("data-bs-toggle")].join(" "))));
  const tops = outermost(headerCandidates);
  const rank = (el) => (holdsToggle(el) ? 100 : 0) + linkCount(el);
  const primary = [...tops].sort((a, b) => rank(b) - rank(a) || top(a) - top(b))[0] ?? null;
  const headerEls = primary ? [primary] : [];
  let headerTop = primary ? top(primary) : 0;
  for (let added = true; added;) {
    added = false;
    for (const el of tops) {
      if (headerEls.includes(el) || bottom(el) > headerTop + 4 || bottom(el) < headerTop - 4 || el.getBoundingClientRect().height > 80) continue;
      headerEls.push(el);
      headerTop = Math.min(headerTop, top(el));
      added = true;
    }
  }
  const headerBottom = primary ? bottom(primary) : 0;
  const inHeader = (el) => headerEls.some((h) => h === el || h.contains(el));

  // -- The footer: the site's closing chrome, stacked up from the lowest one.
  const footerSelector = "footer, [role=contentinfo], [id*=footer i], [class*=footer i]";
  const footerCandidates = [...document.querySelectorAll(footerSelector)].filter((el) => {
    if (!shown(el) || inHeader(el) || headerEls.some((h) => el.contains(h))) return false;
    const r = el.getBoundingClientRect();
    return r.width >= W * 0.5 && r.height >= 8 && r.top + sy >= H * 0.3;
  });
  const footerEls = [];
  let footerTop = Number.POSITIVE_INFINITY;
  for (const el of outermost(footerCandidates).sort((a, b) => bottom(b) - bottom(a))) {
    if (bottom(el) < footerTop - 4 && footerEls.length) break;
    footerEls.push(el);
    footerTop = Math.min(footerTop, top(el));
  }
  const inFooter = (el) => footerEls.some((f) => f === el || f.contains(el));

  // -- The brand mark: the header's link home, or its logo. Its content is
  // the site's own; its place and size are the layout's.
  const marks = new Set();
  const headerLinks = headerEls.flatMap((h) => [...h.querySelectorAll("a[href]")]);
  const home = headerLinks.find((a) => {
    if (!shown(a)) return false;
    try {
      const u = new URL(a.href, location.href);
      return (u.origin === location.origin && /^\/?(index\.html?)?$/i.test(u.pathname)) ||
        /logo|brand/i.test(`${a.id} ${typeof a.className === "string" ? a.className : ""}`);
    } catch {
      return false;
    }
  });
  const logo = home ?? headerEls.flatMap((h) => [...h.querySelectorAll("[class*=logo i], [id*=logo i], [class*=brand i]")]).find(shown);
  if (logo) marks.add(logo);

  // -- The navigation toggle: a menu button in the header band.
  const toggles =[...document.querySelectorAll("button, [role=button], summary, label[for], a, div, span, i")].filter((el) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.height < 14 || r.width > 120 || r.height > 120) return false;
    if (r.top + sy > Math.max(headerBottom, 40) + 10) return false;
    const aria = el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") || el.hasAttribute("aria-haspopup");
    const words = [el.getAttribute("aria-label"), el.getAttribute("title"), el.id, typeof el.className === "string" ? el.className : "",
      el.getAttribute("data-toggle"), el.getAttribute("data-bs-toggle"), el.getAttribute("data-target"), el.getAttribute("data-bs-target")].join(" ");
    if (el.localName === "a") {
      const href = el.getAttribute("href") || "";
      if (href && !/^(#|javascript:)/i.test(href) && !aria) return false;
    }
    return aria || toggleWords.test(words);
  });
  // A wrapper around the button is the same control: press the innermost.
  const innermost = toggles.filter((el) => !toggles.some((other) => other !== el && el.contains(other)));
  const toggleEl = innermost.sort((a, b) => {
    const score = (el) => (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-controls") ? 0 : 1) + (["button", "summary"].includes(el.localName) ? 0 : 1);
    return score(a) - score(b);
  })[0] ?? null;
  document.querySelectorAll("[data-forge-toggle]").forEach((el) => el.removeAttribute("data-forge-toggle"));
  if (toggleEl) toggleEl.setAttribute("data-forge-toggle", "");

  // -- The painted boxes, in paint order.
  const out = [];
  let order = 0;
  const paint = (kind, rect, ctx) => {
    const clipped = intersect(rect, ctx.clip);
    if (clipped) out.push([kind, clipped.x0, clipped.y0, clipped.x1 - clipped.x0, clipped.y1 - clipped.y0, ctx.z, ctx.layer, order++]);
  };
  const iconLike = (el, r) => {
    if (r.width > 64 || r.height > 64) return false;
    const before = getComputedStyle(el, "::before").content;
    return Boolean(before && before !== "none" && before !== "normal" && before !== '""' && !/^url\(/.test(before));
  };
  const walk = (el, ctx) => {
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || Number(cs.opacity) < 0.05) return;
    const positioned = cs.position !== "static";
    const next = { ...ctx };
    if (positioned) next.layer = 1;
    if (positioned && cs.zIndex !== "auto") next.z = Number.parseInt(cs.zIndex, 10) || 0;
    if (cs.position === "fixed") next.clip = PAGE;
    const r = el.getBoundingClientRect();
    const rect = rectOf(r);
    const paints = cs.visibility === "visible" && cs.display !== "contents" && r.width > 0 && r.height > 0;
    if (paints) {
      if (marks.has(el) || (iconLike(el, r) && !el.children.length)) {
        paint(KIND.mark, rect, next);
        return;
      }
      if (MEDIA.has(tag) || (tag === "input" && el.type === "image")) {
        paint(r.width >= 64 && r.height >= 64 ? KIND.media : KIND.mark, rect, next);
        return;
      }
      if (tag === "svg") {
        paint(r.width >= 64 && r.height >= 64 ? KIND.media : KIND.mark, rect, next);
        return;
      }
      const control = ["button", "select", "textarea", "summary"].includes(tag) || el.getAttribute("role") === "button" ||
        (tag === "input" && !["hidden", "checkbox", "radio"].includes(el.type));
      if (tag === "input" && ["checkbox", "radio"].includes(el.type)) {
        paint(KIND.mark, rect, next);
        return;
      }
      const bg = color(cs.backgroundColor);
      const image = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : "";
      const photo = /url\(/.test(image);
      const gradient = /gradient\(/.test(image);
      const edges = ["Top", "Right", "Bottom", "Left"].filter((side) => Number.parseFloat(cs[`border${side}Width`]) >= 1 &&
        cs[`border${side}Style`] !== "none" && (color(cs[`border${side}Color`])?.a ?? 1) > 0.1).length;
      const shadow = cs.boxShadow && cs.boxShadow !== "none";
      const distinct = bg && bg.a >= 0.05 && (!ctx.bg || distance(blend(bg, ctx.bg), ctx.bg) > 18);
      const surface = distinct || gradient || edges >= 3 || shadow;
      if (control || (tag === "a" && surface && r.height <= 96 && r.width <= 640)) {
        paint(KIND.control, rect, next);
        return;
      }
      if (photo && r.width >= 64 && r.height >= 64) paint(KIND.media, rect, next);
      else if (photo) paint(KIND.mark, rect, next);
      else if (surface) paint(KIND.surface, rect, next);
      if (bg && bg.a >= 0.05) next.bg = blend(bg, ctx.bg ?? ground);
      if (photo) next.bg = null;
    }
    if (tag === "svg" || MEDIA.has(tag)) return;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      if (r.width > 0 && r.height > 0) next.clip = intersect(next.clip, rect) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    }
    const heading = ctx.heading || /^h[1-6]$/.test(tag);
    next.heading = heading;
    for (const node of el.childNodes) {
      if (node.nodeType === 1) walk(node, next);
      else if (node.nodeType === 3 && cs.visibility === "visible" && node.textContent.trim()) {
        const ink = color(cs.webkitTextFillColor) ?? color(cs.color);
        const clipText = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
        if (!clipText && ink && ink.a < 0.05) continue;
        const kind = heading || Number.parseFloat(cs.fontSize) >= 24 ? KIND.heading : KIND.text;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          if (line.width < 1 || line.height < 1) continue;
          paint(kind, rectOf(line), next);
        }
      }
    }
  };
  if (document.body) walk(document.body, { clip: PAGE, z: 0, layer: 0, bg: ground, heading: false });
  out.sort((a, b) => a[5] - b[5] || a[6] - b[6] || a[7] - b[7]);
  const boxes = out.map(([kind, x, y, w, h]) => [kind, Math.round(x), Math.round(y), Math.round(w), Math.round(h)]).filter((box) => box[3] > 0 && box[4] > 0);

  // -- Sections (ai-site-cloner detectSections): semantic elements are
  // leaves, wrappers are opened, a run of equal siblings is one collection.
  const blocks = [];
  let footerSignature = null;
  if (!viewportOnly) {
    const LEAF = new Set(["SECTION", "HEADER", "FOOTER", "NAV", "ASIDE", "ARTICLE", "MAIN"]);
    const MIN_H = 40;
    const MAX_SECTION_H = Math.max(1400, VH * 1.6);
    const found = [];
    const visit = (el, depth) => {
      if (depth > 7 || found.length > 40) return;
      for (const child of el.children) {
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG"].includes(child.tagName)) continue;
        const r = child.getBoundingClientRect();
        if (r.height < MIN_H || getComputedStyle(child).display === "none") continue;
        const bigKids = [...child.children].filter((k) => k.getBoundingClientRect().height >= MIN_H);
        const kidHeights = bigKids.map((k) => k.getBoundingClientRect().height);
        const minKid = Math.min(...kidHeights);
        const maxKid = Math.max(...kidHeights);
        const isCollection = bigKids.length >= 3 && new Set(bigKids.map((k) => k.tagName)).size === 1 &&
          maxKid - minKid <= maxKid * 0.25 && r.height <= MAX_SECTION_H;
        if (!isCollection && bigKids.length >= 1) {
          if (r.height > MAX_SECTION_H) { visit(child, depth + 1); continue; }
          if (!LEAF.has(child.tagName) && !child.id && bigKids.length === 1 && bigKids[0].getBoundingClientRect().height >= r.height * 0.92) {
            visit(child, depth + 1);
            continue;
          }
          if (LEAF.has(child.tagName) && bigKids.length > 1 && bigKids.every((k) => LEAF.has(k.tagName))) { visit(child, depth + 1); continue; }
        }
        if (!found.includes(child)) found.push(child);
      }
    };
    if (document.body) visit(document.body, 0);
    const tone = (el) => {
      for (let cur = el; cur; cur = cur.parentElement) {
        const cs = getComputedStyle(cur);
        if (/url\(/.test(cs.backgroundImage) || cur.querySelector(":scope > video, :scope > img, :scope > picture")) {
          const r = cur.getBoundingClientRect();
          const media = cur.querySelector(":scope > video, :scope > img, :scope > picture");
          if (!media || media.getBoundingClientRect().width >= r.width * 0.9) return "image";
        }
        const c = color(cs.backgroundColor);
        if (c && c.a >= 0.5) {
          const l = luminance(c);
          return l < 0.3 ? "dark" : l > 0.75 ? "light" : "mid";
        }
      }
      const l = luminance(ground);
      return l < 0.3 ? "dark" : l > 0.75 ? "light" : "mid";
    };
    // ai-site-cloner measureSections: the container with the most visible
    // children is the section's grid, whatever technique built it.
    const signature = (el) => {
      const cs = getComputedStyle(el);
      const candidates = [el, ...el.querySelectorAll("*")].slice(0, 300);
      const visibleKids = (c) => [...c.children].filter((k) => {
        const kr = k.getBoundingClientRect();
        return kr.width > 40 && kr.height > 40 && getComputedStyle(k).display !== "none";
      });
      let grid = el;
      let most = 0;
      for (const c of candidates) {
        const count = visibleKids(c).length;
        if (count > most) { most = count; grid = c; }
      }
      const items = visibleKids(grid);
      let columns = null;
      if (items.length >= 2) {
        const firstTop = items[0].getBoundingClientRect().top;
        columns = items.filter((k) => Math.abs(k.getBoundingClientRect().top - firstTop) < 10).length;
      }
      const gcs = getComputedStyle(grid);
      const heading = [...el.querySelectorAll("h1,h2,h3")].find(shown);
      return {
        layout: {
          display: gcs.display,
          direction: gcs.flexDirection,
          columns,
          items: items.length,
          gap: gcs.gap && gcs.gap !== "normal" && gcs.gap !== "0px" ? gcs.gap : null,
          gridColumns: gcs.gridTemplateColumns && gcs.gridTemplateColumns !== "none" ? gcs.gridTemplateColumns.split(" ").length : null,
        },
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px).join(" "),
        headingSize: heading ? px(getComputedStyle(heading).fontSize) : null,
        tone: tone(el),
      };
    };
    for (const el of found) {
      if (inHeader(el) || inFooter(el)) continue;
      const r = el.getBoundingClientRect();
      blocks.push({ top: Math.round(r.top + sy), height: Math.round(r.height), tag: el.localName, ...signature(el) });
    }
    blocks.sort((a, b) => a.top - b.top);
    for (let i = blocks.length - 1; i > 0; i -= 1) {
      // A block inside the one above it is already that block.
      const prev = blocks[i - 1];
      if (blocks[i].top >= prev.top && blocks[i].top + blocks[i].height <= prev.top + prev.height) blocks.splice(i, 1);
    }
    if (footerEls.length) footerSignature = signature(footerEls[footerEls.length - 1]);
  }

  // -- The type scale, by role, in sizes only.
  const role = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { size: px(cs.fontSize), weight: Number(cs.fontWeight) || cs.fontWeight, lineHeight: cs.lineHeight === "normal" ? "normal" : px(cs.lineHeight),
      tracking: cs.letterSpacing === "normal" ? 0 : Number.parseFloat(cs.letterSpacing), transform: cs.textTransform, italic: cs.fontStyle === "italic" };
  };
  const firstShown = (selector, test) => [...document.querySelectorAll(selector)].find((el) => shown(el) && (!test || test(el)));
  const type = viewportOnly ? null : {
    h1: role(firstShown("h1")),
    h2: role(firstShown("h2")),
    h3: role(firstShown("h3")),
    body: role(firstShown("p", (el) => el.textContent.trim().length >= 40)),
    nav: role(headerLinks.find((a) => shown(a) && a.textContent.trim() && !marks.has(a))),
    button: role(firstShown("button, a[class*=btn i], a[class*=button i], input[type=submit]", (el) => (el.textContent || el.value || "").trim().length >= 2)),
  };

  const firstBlock = blocks[0];
  const header = headerEls.length ? {
    bottom: Math.round(headerBottom),
    overlay: Boolean(firstBlock && firstBlock.top < headerBottom - 4),
    fixed: headerEls.some((el) => ["fixed", "sticky"].includes(getComputedStyle(el).position)),
    links: headerLinks.filter(shown).length,
    toggle: toggleEl ? (() => { const t = toggleEl.getBoundingClientRect(); return { x: Math.round(t.left), y: Math.round(t.top + sy), w: Math.round(t.width), h: Math.round(t.height) }; })() : null,
  } : null;
  const footer = footerEls.length ? { top: Math.round(footerTop), ...(footerSignature ?? {}) } : null;

  // -- Where the site's own pages are, for choosing what to capture.
  const links = discover ? [...new Set(headerLinks.map((a) => a.href))] : [];

  return { width: W, height: Math.round(viewportOnly ? VH : H), viewportHeight: VH, boxes, header, footer, sections: blocks, type, links };
}

// Before the menu opens: note which links are already on screen, so the ones
// the menu reveals can be counted.
function markVisibleLinks() {
  for (const a of document.querySelectorAll("a[href]")) {
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && r.bottom > 0 && r.top < window.innerHeight) a.setAttribute("data-forge-seen", "");
  }
}

// What the opened menu revealed, in the first screen.
function revealedInPage() {
  const W = document.documentElement.clientWidth;
  const H = window.innerHeight;
  const fresh = [...document.querySelectorAll("a[href]")].filter((a) => {
    if (a.hasAttribute("data-forge-seen")) return false;
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
  });
  if (!fresh.length) return { links: 0, panel: null };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of fresh) {
    const r = a.getBoundingClientRect();
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  return { links: fresh.length, panel: { x: Math.round(Math.max(0, x0)), y: Math.round(Math.max(0, y0)), w: Math.round(Math.min(W, x1) - Math.max(0, x0)), h: Math.round(Math.min(H, y1) - Math.max(0, y0)) } };
}

async function waitStill(page, { timeout = 3000, every = 150 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const now = await page
      .evaluate(() => {
        const H = window.innerHeight;
        let count = 0;
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top < H && r.bottom > 0 && getComputedStyle(el).visibility !== "hidden") count += 1;
        }
        return `${count}:${document.documentElement.scrollHeight}`;
      })
      .catch(() => null);
    if (now !== null && now === last) return;
    last = now;
    await page.waitForTimeout(every);
  }
}

// ---------------------------------------------------------------------------
// One page at one width: load, normalise, wake, freeze, measure, open the
// menu, measure again. `serve` answers the audit origin's requests.
// ---------------------------------------------------------------------------

export async function measurePage(browser, url, viewportName, { serve = null, discover = false, shots = null } = {}) {
  const viewport = VIEWPORTS[viewportName];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block", userAgent: UA });
  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const target = route.request().url();
      if (serve && target.startsWith(`${AUDIT_ORIGIN}/`)) {
        const found = serve(new URL(target).pathname);
        return found === null
          ? route.fulfill({ status: 404, contentType: "text/html", body: "Not found" })
          : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: found });
      }
      return publicUrl(target) ? route.continue() : route.abort();
    });
    const response = await page.goto(url, { waitUntil: "load", timeout: 45000 });
    if (!response || response.status() >= 400) throw new Error(`The page answered ${response ? response.status() : "nothing"}`);
    await settle(page);
    await page.evaluate(normalizeInPage).catch(() => 0);
    await autoScroll(page);
    await page.evaluate(normalizeInPage).catch(() => 0);
    await freeze(page);
    const measured = await page.evaluate(measureInPage, { discover });
    if (shots) await page.screenshot({ path: `${shots}.jpg`, fullPage: true, type: "jpeg", quality: 55 }).catch(() => {});
    measured.menu = await openMenu(page, measured, shots);
    return measured;
  } finally {
    await context.close().catch(() => {});
  }
}

// The navigation opened, when the page has a menu button at this width:
// clicked, waited out, frozen, and measured over the first screen. Without a
// button the menu region is the first screen as it stands.
async function openMenu(page, measured, shots) {
  const closed = measured.boxes.filter(([, , y]) => y < measured.viewportHeight);
  if (!measured.header?.toggle) return { opened: false, boxes: closed, links: 0, panel: null };
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.evaluate(markVisibleLinks).catch(() => {});
  const clicked = await page
    .locator("[data-forge-toggle]")
    .first()
    .click({ timeout: 4000 })
    .then(() => true, () => false);
  if (!clicked) return { opened: false, boxes: closed, links: 0, panel: null, problem: "the menu button could not be pressed" };
  await waitStill(page);
  await freeze(page);
  const after = await page.evaluate(measureInPage, { viewportOnly: true });
  const revealed = await page.evaluate(revealedInPage).catch(() => ({ links: 0, panel: null }));
  if (shots) await page.screenshot({ path: `${shots}-menu.jpg`, type: "jpeg", quality: 55 }).catch(() => {});
  return { opened: true, boxes: after.boxes, ...revealed };
}
