// Layout masks, and the deterministic check that compares them.
//
// A captured page is a list of painted boxes, each one of six kinds: a surface
// (a panel, band or card that stands off what is behind it), a media slot, a
// line of text, a line of heading, a control, or a mark (a logo or an icon).
// Everything else is background. The words, the pictures, the logos, the
// colours and the font families are not in it, so a site written in its own
// words with its own pictures can match the layout it was measured from, and a
// site that only shares a header cannot.
//
// The check is a pixel diff of two such masks. ai-site-cloner
// (https://github.com/Mahanaicoach/ai-site-cloner, MIT, see NOTICE) scores raw
// screenshots with pixelmatch in ten horizontal bands and compares heights
// separately; a Forge page intentionally has different copy, so text of a
// different length moves everything under it. The rows of the two masks are
// therefore aligned first (dynamic time warping, local slope between 1/2 and
// 2, so no stretch past double can line up), then scored cell by cell over the
// cells either side paints, with the same ten-band breakdown to say where a
// page drifts.
//
// Nothing here opens a browser: capture.mjs measures, this file judges.

export const KINDS = ["background", "surface", "media", "text", "heading", "control", "mark"];
export const KIND = Object.fromEntries(KINDS.map((name, index) => [name, index]));

// The three widths every capture and every check covers, ai-site-cloner's.
export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};
export const VIEWPORT_NAMES = Object.keys(VIEWPORTS);

// Mask cells in CSS pixels, [wide, tall]: about a hundred to two hundred
// columns at every width, and the same eight-pixel rows everywhere.
export const CELL = { phone: [4, 8], tablet: [6, 8], desktop: [8, 8] };

export const REGIONS = ["full", "header", "menu", "body", "footer"];

// The lowest score each region may have, on every route at every width.
// Calibrated in checks/calibration.md: the measured Taqueria build fails its
// body and footer, a copy-and-font restyle of the reference passes.
export const THRESHOLDS = { full: 0.8, header: 0.8, menu: 0.8, body: 0.8, footer: 0.8 };

const BANDS = 10;

// Paints `boxes` ([kind, x, y, w, h] in page pixels, in paint order) into the
// mask of the region [top, bottom). A cell takes the kind of the last box that
// covers its centre.
export function rasterize(boxes, { width, top = 0, bottom, cell }) {
  const [cx, cy] = cell;
  const cols = Math.ceil(width / cx);
  const height = Math.max(0, bottom - top);
  const rows = Math.ceil(height / cy);
  const data = new Uint8Array(cols * rows);
  for (const box of boxes) {
    const [kind, x, y, w, h] = box;
    if (!kind || w <= 0 || h <= 0) continue;
    const c0 = Math.max(0, Math.ceil((x - cx / 2) / cx));
    const c1 = Math.min(cols - 1, Math.floor((x + w - cx / 2 - 1e-9) / cx));
    const r0 = Math.max(0, Math.ceil((y - top - cy / 2) / cy));
    const r1 = Math.min(rows - 1, Math.floor((y - top + h - cy / 2 - 1e-9) / cy));
    if (c1 < c0 || r1 < r0) continue;
    for (let r = r0; r <= r1; r += 1) data.fill(kind, r * cols + c0, r * cols + c1 + 1);
  }
  return { cols, rows, cell, top, height, data };
}

// How two rows of the same width disagree: the cells either paints, and of
// those the ones they paint differently. A boundary that moved by one cell is
// the same boundary -- the label on each side is found one cell over on the
// other -- which is the same allowance pixelmatch gives antialiased edges.
function rowCost(a, ai, b, bi, cols) {
  let mismatch = 0;
  let union = 0;
  for (let c = 0; c < cols; c += 1) {
    const p = a[ai + c];
    const q = b[bi + c];
    if (p === 0 && q === 0) continue;
    union += 1;
    if (p === q) continue;
    const pNear = (c > 0 && b[bi + c - 1] === p) || (c < cols - 1 && b[bi + c + 1] === p);
    const qNear = (c > 0 && a[ai + c - 1] === q) || (c < cols - 1 && a[ai + c + 1] === q);
    if (pNear && qNear) continue;
    mismatch += 1;
  }
  return [mismatch, union];
}

// Aligns the rows of `ref` with the rows of `cand` so the fewest cells
// disagree. Steps are one row against one row, one reference row against two
// candidate rows, or two against one, so a section may run up to twice as tall
// or half as tall as the one it copies and nothing beyond that lines up.
// Returns the pairs of the best alignment, or null when none can exist.
export function alignRows(ref, cand) {
  const n = ref.rows;
  const m = cand.rows;
  const cols = ref.cols;
  if (n === 0 || m === 0 || m > 2 * n || n > 2 * m) return null;
  const INF = Number.POSITIVE_INFINITY;
  const a = ref.data;
  const b = cand.data;
  // Rolling rows of the least mismatch ending at each pair, and the union
  // tallied along that same path. Three are live: this row and the two above.
  const D = [0, 1, 2].map(() => new Float64Array(m).fill(INF));
  const U = [0, 1, 2].map(() => new Float64Array(m));
  // Row costs, worked out once each: this reference row's and the last one's.
  const costs = [new Float64Array(m * 2).fill(Number.NaN), new Float64Array(m * 2).fill(Number.NaN)];
  const cost = (i, j) => {
    const row = costs[i % 2];
    if (Number.isNaN(row[j * 2])) {
      const [mis, uni] = rowCost(a, i * cols, b, j * cols, cols);
      row[j * 2] = mis;
      row[j * 2 + 1] = uni;
    }
    return row;
  };
  // Which step ended at each pair: 1 one-to-one, 2 one-to-two, 3 two-to-one.
  const step = new Uint8Array(n * m);
  // What a path ending at (i, j) cost, or the start before any row, or nothing.
  const at = (i, j) => (i === -1 && j === -1 ? 0 : i < 0 || j < 0 ? INF : D[i % 3][j]);
  const atU = (i, j) => (i < 0 || j < 0 ? 0 : U[i % 3][j]);
  for (let i = 0; i < n; i += 1) {
    D[i % 3].fill(INF);
    U[i % 3].fill(0);
    costs[i % 2].fill(Number.NaN);
    // Only pairs a path from the start can reach and still finish from.
    const lo = Math.max(0, Math.ceil((i + 1) / 2) - 1, m - 1 - 2 * (n - 1 - i));
    const hi = Math.min(m - 1, 2 * (i + 1) - 1, m - 1 - Math.ceil((n - 1 - i) / 2));
    for (let j = lo; j <= hi; j += 1) {
      const here = cost(i, j);
      let best = INF;
      let union = 0;
      let move = 0;
      const one = at(i - 1, j - 1);
      if (one < best) {
        best = one;
        union = atU(i - 1, j - 1);
        move = 1;
      }
      if (j >= 1) {
        const before = at(i - 1, j - 2);
        if (Number.isFinite(before)) {
          const extra = cost(i, j - 1);
          if (before + extra[(j - 1) * 2] < best) {
            best = before + extra[(j - 1) * 2];
            union = atU(i - 1, j - 2) + extra[(j - 1) * 2 + 1];
            move = 2;
          }
        }
      }
      if (i >= 1) {
        const before = at(i - 2, j - 1);
        if (Number.isFinite(before)) {
          const extra = cost(i - 1, j);
          if (before + extra[j * 2] < best) {
            best = before + extra[j * 2];
            union = atU(i - 2, j - 1) + extra[j * 2 + 1];
            move = 3;
          }
        }
      }
      if (!move) continue;
      D[i % 3][j] = best + here[j * 2];
      U[i % 3][j] = union + here[j * 2 + 1];
      step[i * m + j] = move;
    }
  }
  if (!Number.isFinite(D[(n - 1) % 3][m - 1])) return null;
  // Walk the best path back from the last pair to the start.
  const pairs = [];
  let i = n - 1;
  let j = m - 1;
  while (i >= 0 || j >= 0) {
    const move = i >= 0 && j >= 0 ? step[i * m + j] : 0;
    if (move === 1) {
      pairs.push([i, j]);
      i -= 1;
      j -= 1;
    } else if (move === 2) {
      pairs.push([i, j], [i, j - 1]);
      i -= 1;
      j -= 2;
    } else if (move === 3) {
      pairs.push([i, j], [i - 1, j]);
      i -= 2;
      j -= 1;
    } else {
      return null;
    }
  }
  pairs.reverse();
  return pairs;
}

// The score of one region: of the cells either mask paints along the best
// alignment, the share both paint the same. Ten bands over the reference's
// height say where it drifts; `rowMap` says which candidate rows each
// reference row landed on, so a failing band can be named as the section it
// is and the section it met.
export function scoreMasks(ref, cand) {
  const heights = { reference: Math.round(ref.height), candidate: Math.round(cand.height) };
  const frame = { cell: ref.cell[1], refTop: ref.top, candTop: cand.top };
  if (ref.cols !== cand.cols) throw new Error("Masks of different widths cannot be compared");
  if (ref.rows === 0 && cand.rows === 0) return { score: 1, heights, ...frame, bands: [], rowMap: [] };
  if (ref.rows === 0 || cand.rows === 0) {
    return { score: 0, heights, ...frame, bands: [], rowMap: [], reason: ref.rows === 0 ? "extra" : "missing" };
  }
  const pairs = alignRows(ref, cand);
  if (!pairs) return { score: 0, heights, ...frame, bands: [], rowMap: [], reason: "height" };
  const rowMap = Array.from({ length: ref.rows }, () => [Number.POSITIVE_INFINITY, -1]);
  const whole = tally();
  const byBand = Array.from({ length: BANDS }, tally);
  for (const [i, j] of pairs) {
    const band = Math.min(BANDS - 1, Math.floor((i / ref.rows) * BANDS));
    countRow(ref.data, i * ref.cols, cand.data, j * ref.cols, ref.cols, whole, byBand[band]);
    rowMap[i][0] = Math.min(rowMap[i][0], j);
    rowMap[i][1] = Math.max(rowMap[i][1], j);
  }
  const bands = [];
  for (let band = 0; band < BANDS; band += 1) {
    const r0 = Math.floor((ref.rows * band) / BANDS);
    const r1 = band === BANDS - 1 ? ref.rows : Math.floor((ref.rows * (band + 1)) / BANDS);
    if (r1 <= r0) continue;
    bands.push({ from: ref.top + r0 * ref.cell[1], to: ref.top + r1 * ref.cell[1], score: round(balanced(byBand[band])) });
  }
  return { score: round(balanced(whole)), agreement: round(agreement(whole)), kinds: dice(whole), heights, ...frame, bands, rowMap };
}

// Per kind: cells the reference paints with it, cells the candidate does, and
// of each the ones the other side paints the same (one cell over counts, as in
// rowCost). Plus the plain union and mismatch counts.
function tally() {
  return { ref: new Float64Array(KINDS.length), cand: new Float64Array(KINDS.length), refHit: new Float64Array(KINDS.length), candHit: new Float64Array(KINDS.length), mismatch: 0, union: 0 };
}

function countRow(a, ai, b, bi, cols, ...into) {
  for (let c = 0; c < cols; c += 1) {
    const p = a[ai + c];
    const q = b[bi + c];
    if (p === 0 && q === 0) continue;
    const pFound = p !== 0 && (q === p || (c > 0 && b[bi + c - 1] === p) || (c < cols - 1 && b[bi + c + 1] === p));
    const qFound = q !== 0 && (p === q || (c > 0 && a[ai + c - 1] === q) || (c < cols - 1 && a[ai + c + 1] === q));
    const same = p === q || ((p === 0 || pFound) && (q === 0 || qFound) && p !== 0 && q !== 0);
    for (const t of into) {
      t.union += 1;
      if (!same) t.mismatch += 1;
      if (p !== 0) {
        t.ref[p] += 1;
        if (pFound) t.refHit[p] += 1;
      }
      if (q !== 0) {
        t.cand[q] += 1;
        if (qFound) t.candHit[q] += 1;
      }
    }
  }
}

// Dice for each kind either side paints.
function dice(t) {
  const out = {};
  for (let k = 1; k < KINDS.length; k += 1) {
    const total = t.ref[k] + t.cand[k];
    if (total) out[KINDS[k]] = round((t.refHit[k] + t.candHit[k]) / total);
  }
  return out;
}

// The region's score: each kind's Dice, weighted by the square root of how
// much of the region that kind paints. A wide band of one colour weighs more
// than a line of text, but not so much that it hides where the text, the
// pictures and the controls sit -- a plain share of matching cells lets a
// footer of four columns pass for a two-line strip because both are one dark
// band.
function balanced(t) {
  let weight = 0;
  let sum = 0;
  for (let k = 1; k < KINDS.length; k += 1) {
    const total = t.ref[k] + t.cand[k];
    if (!total) continue;
    const w = Math.sqrt(total);
    weight += w;
    sum += w * ((t.refHit[k] + t.candHit[k]) / total);
  }
  return weight ? sum / weight : 1;
}

function agreement(t) {
  return t.union ? 1 - t.mismatch / t.union : 1;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

// Where each region of a captured page runs, top to bottom. The header is the
// site's own chrome at the top, the footer its closing chrome at the bottom,
// the body everything between; the menu is the first screen with the
// navigation opened (or as it stands, where there is nothing to open).
export function regionBounds(page) {
  const headerBottom = Math.max(0, Math.min(page.height, page.header ? page.header.bottom : 0));
  const footerTop = Math.max(headerBottom, Math.min(page.height, page.footer ? page.footer.top : page.height));
  return {
    full: [0, page.height],
    header: [0, headerBottom],
    body: [headerBottom, footerTop],
    footer: [footerTop, page.height],
    menu: [0, page.viewportHeight],
  };
}

export function regionMask(page, region, viewportName) {
  const [top, bottom] = regionBounds(page)[region];
  const boxes = region === "menu" ? (page.menu?.boxes ?? page.boxes) : page.boxes;
  return rasterize(boxes, { width: page.width, top, bottom, cell: CELL[viewportName] });
}

// Every region of one route at one width, reference against candidate.
export function compareRoute(refPage, candPage, viewportName) {
  const regions = {};
  for (const region of REGIONS) {
    const ref = regionMask(refPage, region, viewportName);
    const cand = regionMask(candPage, region, viewportName);
    const result = scoreMasks(ref, cand);
    regions[region] = { ...result, threshold: THRESHOLDS[region], passed: result.score >= THRESHOLDS[region] };
  }
  return regions;
}

// The whole check: every route of the reference, at every width, in every
// region. A route the reference has and the site does not, a route the site
// has and the reference does not, and a width either side is missing all fail
// -- a check with no evidence is a failed check.
export function auditSite(reference, candidate) {
  const results = [];
  const refPaths = reference.routes.map((route) => route.path);
  const candPaths = candidate.routes.map((route) => route.path);
  for (const path of candPaths) {
    if (!refPaths.includes(path)) results.push({ path, passed: false, problem: "extra", viewports: {} });
  }
  for (const refRoute of reference.routes) {
    const candRoute = candidate.routes.find((route) => route.path === refRoute.path);
    if (!candRoute) {
      results.push({ path: refRoute.path, passed: false, problem: "missing", viewports: {} });
      continue;
    }
    const viewports = {};
    let passed = true;
    for (const name of VIEWPORT_NAMES) {
      const refPage = refRoute.viewports?.[name];
      const candPage = candRoute.viewports?.[name];
      if (!refPage || !candPage || candPage.error) {
        viewports[name] = { passed: false, problem: candPage?.error ?? "not measured" };
        passed = false;
        continue;
      }
      const regions = compareRoute(refPage, candPage, name);
      const ok = REGIONS.every((region) => regions[region].passed);
      viewports[name] = { passed: ok, regions };
      if (!ok) passed = false;
    }
    results.push({ path: refRoute.path, passed, viewports });
  }
  return { passed: results.length > 0 && results.every((route) => route.passed), routes: results };
}

// ---------------------------------------------------------------------------
// Describing blocks: the same words for the builder's spec and for the fixes
// a failed check sends back, so "what the reference has" and "what yours has"
// are always said the same way.
// ---------------------------------------------------------------------------

const px = (value) => `${Math.round(value)}px`;

// What a horizontal slice of a page holds, read from its boxes alone.
export function summarizeBlock(boxes, top, bottom, width) {
  const inside = boxes.filter(([kind, , y, , h]) => kind && y < bottom && y + h > top);
  const count = (kind) => inside.filter((box) => box[0] === kind).length;
  const media = inside.filter((box) => box[0] === KIND.media);
  const words = inside.filter((box) => box[0] === KIND.text || box[0] === KIND.heading);
  const height = Math.max(1, bottom - top);
  const cover = media.reduce((sum, [, x, y, w, h]) => {
    const overlap = Math.max(0, Math.min(bottom, y + h) - Math.max(top, y));
    return sum + Math.min(w, width) * overlap;
  }, 0) / (width * height);
  const fullBleed = media.some(([, x, , w]) => x <= 2 && w >= width - 4);
  let mediaSide = null;
  if (media.length && !fullBleed) {
    const centre = media.reduce((sum, [, x, , w]) => sum + x + w / 2, 0) / media.length / width;
    const spread = media.length >= 3 && new Set(media.map(([, x]) => Math.round(x / (width / 12)))).size >= 3;
    mediaSide = spread ? "spread" : centre < 0.4 ? "left" : centre > 0.6 ? "right" : "centre";
  }
  let align = null;
  if (words.length) {
    const centres = words.map(([, x, , w]) => (x + w / 2) / width);
    const centred = centres.filter((c) => Math.abs(c - 0.5) < 0.04).length;
    align = centred / words.length > 0.6 ? "centred" : "left";
  }
  const left = words.length ? Math.min(...words.map(([, x]) => x)) : null;
  const right = words.length ? Math.max(...words.map(([, x, , w]) => x + w)) : null;
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    height: Math.round(bottom - top),
    media: media.length,
    mediaCover: Math.round(cover * 100),
    fullBleed,
    mediaSide,
    headingLines: count(KIND.heading),
    textLines: count(KIND.text),
    controls: count(KIND.control),
    marks: count(KIND.mark),
    surfaces: count(KIND.surface),
    align,
    column: left === null ? null : [Math.round(left), Math.round(right)],
  };
}

export function describeBlock(block, section) {
  const parts = [`${px(block.top)}–${px(block.bottom)} (${px(block.height)} tall)`];
  const layout = section?.layout;
  if (layout?.columns && layout.columns > 1) {
    parts.push(`${layout.columns} columns${layout.items ? ` of ${layout.items} items` : ""}${layout.gap && layout.gap !== "normal" ? `, gap ${layout.gap}` : ""}`);
  } else if (layout?.items && layout.items > 1) {
    parts.push(`${layout.items} items stacked${layout.gap && layout.gap !== "normal" ? `, gap ${layout.gap}` : ""}`);
  }
  if (block.media) {
    const where = block.fullBleed ? "full-bleed" : block.mediaSide ?? "";
    parts.push(`${block.media} image slot${block.media === 1 ? "" : "s"}${where ? ` (${where})` : ""} covering ${block.mediaCover}%`);
  }
  if (block.headingLines) parts.push(`${block.headingLines} heading line${block.headingLines === 1 ? "" : "s"}`);
  if (block.textLines) parts.push(`${block.textLines} text line${block.textLines === 1 ? "" : "s"}`);
  if (block.align) parts.push(`${block.align} text${block.column ? ` in ${px(block.column[0])}–${px(block.column[1])}` : ""}`);
  if (block.controls) parts.push(`${block.controls} control${block.controls === 1 ? "" : "s"}`);
  if (block.surfaces) parts.push(`${block.surfaces} panel${block.surfaces === 1 ? "" : "s"}`);
  if (section?.tone) parts.push(`${section.tone} ground`);
  if (section?.padding) parts.push(`padding ${section.padding}`);
  return parts.join("; ");
}

// The sections of a page that sit inside [top, bottom), in order.
export function sectionsIn(page, top, bottom) {
  return (page.sections ?? []).filter((section) => {
    const middle = section.top + section.height / 2;
    return middle >= top && middle < bottom;
  });
}

// The fixes a failed route sends back, in the reference's own measurements:
// which region failed, which of the reference's sections the failing rows are,
// and what the site put where they landed. Deterministic, and never a verdict
// about taste.
export function repairNotes(reference, candidate, audit) {
  const notes = [];
  const refPaths = reference.routes.map((route) => route.path);
  for (const route of audit.routes) {
    if (route.problem === "extra") {
      notes.push(`Route ${route.path} has no page in the reference. Remove it: the reference's routes are ${refPaths.join(", ")}.`);
      continue;
    }
    if (route.problem === "missing") {
      notes.push(`Route ${route.path} is missing. Build it as its own page, following its measured layout.`);
      continue;
    }
    if (route.passed) continue;
    const refRoute = reference.routes.find((item) => item.path === route.path);
    const candRoute = candidate.routes.find((item) => item.path === route.path);
    for (const name of VIEWPORT_NAMES) {
      const result = route.viewports[name];
      if (!result || result.passed) continue;
      const refPage = refRoute?.viewports?.[name];
      const candPage = candRoute?.viewports?.[name];
      const where = `${route.path} at ${name} (${VIEWPORTS[name].width}px)`;
      if (!result.regions) {
        notes.push(`${where}: could not be measured (${result.problem}).`);
        continue;
      }
      for (const region of REGIONS) {
        const outcome = result.regions[region];
        if (outcome.passed) continue;
        notes.push(...regionNotes(where, region, outcome, refPage, candPage));
      }
    }
  }
  return notes;
}

function regionNotes(where, region, outcome, refPage, candPage) {
  const score = `${Math.round(outcome.score * 100)}% against ${Math.round(outcome.threshold * 100)}%`;
  const heights = `the reference's is ${px(outcome.heights.reference)} tall, yours ${px(outcome.heights.candidate)}`;
  const out = [];
  if (region === "header") {
    const ref = refPage.header;
    const cand = candPage.header;
    out.push(`${where}, header (${score}): ${heights}. Reference header: ${headerWords(ref)}. Yours: ${headerWords(cand)}.`);
    return out;
  }
  if (region === "menu") {
    out.push(`${where}, menu (${score}): reference ${menuWords(refPage)}; yours ${menuWords(candPage)}.`);
    return out;
  }
  if (outcome.reason === "height" || outcome.reason === "missing" || outcome.reason === "extra") {
    out.push(`${where}, ${region} (${score}): ${heights}, too far apart to line up. Match the reference's sections and their heights.`);
  } else {
    out.push(`${where}, ${region} (${score}): ${heights}.`);
  }
  const [top, bottom] = regionBounds(refPage)[region];
  const refSections = region === "footer" ? [] : sectionsIn(refPage, top, bottom);
  const { cell, candTop } = outcome;
  const bandAt = (y) => outcome.bands.find((band) => y >= band.from && y < band.to);
  for (const [index, section] of refSections.entries()) {
    const r0 = Math.max(0, Math.floor((section.top - top) / cell));
    const r1 = Math.min(outcome.rowMap.length - 1, Math.floor((section.top + section.height - 1 - top) / cell));
    const band = bandAt(section.top + section.height / 2);
    if (band && band.score >= outcome.threshold) continue;
    const refBlock = summarizeBlock(refPage.boxes, section.top, section.top + section.height, refPage.width);
    let yours = "nothing lines up with it";
    if (outcome.rowMap.length && r1 >= r0) {
      const from = Math.min(...outcome.rowMap.slice(r0, r1 + 1).map(([lo]) => lo).filter(Number.isFinite));
      const to = Math.max(...outcome.rowMap.slice(r0, r1 + 1).map(([, hi]) => hi));
      if (Number.isFinite(from) && to >= from) {
        const y0 = candTop + from * cell;
        const y1 = candTop + (to + 1) * cell;
        const candBlock = summarizeBlock(candPage.boxes, y0, y1, candPage.width);
        const met = sectionsIn(candPage, y0, y1);
        yours = `${describeBlock(candBlock, met.length === 1 ? met[0] : null)}${met.length > 1 ? ` (${met.length} of your sections)` : ""}`;
      }
    }
    out.push(`  Reference section ${index + 1} of ${refSections.length}: ${describeBlock(refBlock, section)}. Yours there: ${yours}.`);
  }
  if (region === "footer") {
    const refBlock = summarizeBlock(refPage.boxes, top, bottom, refPage.width);
    const [cTop, cBottom] = regionBounds(candPage).footer;
    const candBlock = summarizeBlock(candPage.boxes, cTop, cBottom, candPage.width);
    out.push(`  Reference footer: ${describeBlock(refBlock, refPage.footer)}. Yours: ${cBottom > cTop ? describeBlock(candBlock, candPage.footer) : "none"}.`);
  }
  return out;
}

function headerWords(header) {
  if (!header) return "none found";
  const bits = [`${px(header.bottom)} tall`];
  bits.push(header.overlay ? "laid over the opening" : "above the opening");
  if (header.fixed) bits.push("stays on screen");
  if (typeof header.links === "number") bits.push(`${header.links} visible links`);
  if (header.toggle) bits.push(`a menu button at ${px(header.toggle.x)},${px(header.toggle.y)} (${px(header.toggle.w)}×${px(header.toggle.h)})`);
  return bits.join(", ");
}

function menuWords(page) {
  const menu = page.menu;
  if (!menu || !menu.opened) return "has nothing to open at this width";
  const opened = menu.panel ? `a ${px(menu.panel.w)}×${px(menu.panel.h)} panel at ${px(menu.panel.x)},${px(menu.panel.y)}` : "no visible panel";
  return `opens ${opened} with ${menu.links ?? 0} links`;
}

// ---------------------------------------------------------------------------
// Mask images, for whoever checks a run by eye. Plain truecolour PNG, written
// with node's zlib so the worker has no image dependency.
// ---------------------------------------------------------------------------

const COLOURS = [
  [255, 255, 255], // background
  [205, 214, 228], // surface
  [70, 110, 190], // media
  [40, 40, 40], // text
  [200, 60, 50], // heading
  [240, 170, 40], // control
  [60, 160, 90], // mark
];

export function maskImage(mask) {
  const scale = Math.max(1, Math.round(4 / Math.max(1, mask.cell[0] / 2)));
  const width = mask.cols * scale;
  const height = mask.rows * scale;
  const rgb = new Uint8Array(width * height * 3);
  for (let r = 0; r < mask.rows; r += 1) {
    for (let c = 0; c < mask.cols; c += 1) {
      const [red, green, blue] = COLOURS[mask.data[r * mask.cols + c]] ?? COLOURS[0];
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = ((r * scale + dy) * width + c * scale + dx) * 3;
          rgb[at] = red;
          rgb[at + 1] = green;
          rgb[at + 2] = blue;
        }
      }
    }
  }
  return { width, height, rgb };
}

// Two masks side by side, reference on the left.
export function pairImage(ref, cand) {
  const a = maskImage(ref);
  const b = maskImage(cand);
  const gap = 8;
  const width = a.width + gap + b.width;
  const height = Math.max(a.height, b.height, 1);
  const rgb = new Uint8Array(width * height * 3).fill(128);
  const blit = (img, x0) => {
    for (let y = 0; y < img.height; y += 1) {
      rgb.set(img.rgb.subarray(y * img.width * 3, (y + 1) * img.width * 3), (y * width + x0) * 3);
    }
  };
  blit(a, 0);
  blit(b, a.width + gap);
  return { width, height, rgb };
}

export async function encodePng({ width, height, rgb }) {
  const { deflateSync } = await import("node:zlib");
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}
