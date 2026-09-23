// node --test checks/   (from design-worker/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIND,
  THRESHOLDS,
  VIEWPORTS,
  alignRows,
  auditSite,
  encodePng,
  pairImage,
  rasterize,
  regionBounds,
  repairNotes,
  scoreMasks,
  summarizeBlock,
} from "../layout.mjs";

const cell = [8, 8];

// A page of stacked bands: [kind, height] from the top, full width, with a
// heading line and a text line inside every non-media band.
function page(bands, width = 400) {
  const boxes = [];
  let y = 0;
  for (const [kind, height] of bands) {
    if (kind === KIND.media) boxes.push([KIND.media, 0, y, width, height]);
    else {
      if (kind === KIND.surface) boxes.push([KIND.surface, 0, y, width, height]);
      boxes.push([KIND.heading, 40, y + 16, width / 2, 32]);
      boxes.push([KIND.text, 40, y + 64, width - 120, 16]);
      boxes.push([KIND.control, 40, y + 96, 120, 40]);
    }
    y += height;
  }
  return { boxes, height: y };
}

test("a cell takes the kind of the last box over its centre", () => {
  const mask = rasterize([[KIND.surface, 0, 0, 64, 64], [KIND.media, 16, 16, 16, 16]], { width: 64, bottom: 64, cell });
  assert.equal(mask.cols, 8);
  assert.equal(mask.rows, 8);
  assert.equal(mask.data[0], KIND.surface);
  assert.equal(mask.data[2 * 8 + 2], KIND.media);
  assert.equal(mask.data[3 * 8 + 3], KIND.media);
  assert.equal(mask.data[4 * 8 + 4], KIND.surface);
});

test("the same page scores 1", () => {
  const a = page([[KIND.media, 400], [KIND.background, 300], [KIND.surface, 240]]);
  const ref = rasterize(a.boxes, { width: 400, bottom: a.height, cell });
  const cand = rasterize(a.boxes, { width: 400, bottom: a.height, cell });
  assert.equal(scoreMasks(ref, cand).score, 1);
});

test("taller copy of the same layout still lines up", () => {
  const a = page([[KIND.media, 400], [KIND.background, 300], [KIND.surface, 240], [KIND.background, 200]]);
  const b = page([[KIND.media, 440], [KIND.background, 420], [KIND.surface, 300], [KIND.background, 260]]);
  const result = scoreMasks(
    rasterize(a.boxes, { width: 400, bottom: a.height, cell }),
    rasterize(b.boxes, { width: 400, bottom: b.height, cell }),
  );
  assert.ok(result.score > 0.9, `score ${result.score}`);
});

test("a different composition scores low", () => {
  const a = page([[KIND.media, 400], [KIND.surface, 300], [KIND.media, 600], [KIND.surface, 240]]);
  const b = page([[KIND.background, 300], [KIND.background, 300], [KIND.background, 300], [KIND.background, 300]]);
  const result = scoreMasks(
    rasterize(a.boxes, { width: 400, bottom: a.height, cell }),
    rasterize(b.boxes, { width: 400, bottom: b.height, cell }),
  );
  assert.ok(result.score < 0.5, `score ${result.score}`);
});

test("nothing past double or half the height lines up", () => {
  const a = page([[KIND.media, 800]]);
  const b = page([[KIND.media, 300]]);
  const ref = rasterize(a.boxes, { width: 400, bottom: a.height, cell });
  const cand = rasterize(b.boxes, { width: 400, bottom: b.height, cell });
  assert.equal(alignRows(ref, cand), null);
  const result = scoreMasks(ref, cand);
  assert.equal(result.score, 0);
  assert.equal(result.reason, "height");
});

test("an empty region matches an empty region and nothing else", () => {
  const empty = rasterize([], { width: 400, bottom: 0, cell });
  const some = rasterize([[KIND.text, 0, 0, 100, 16]], { width: 400, bottom: 16, cell });
  assert.equal(scoreMasks(empty, empty).score, 1);
  assert.equal(scoreMasks(some, empty).score, 0);
  assert.equal(scoreMasks(empty, some).score, 0);
});

test("a boundary moved by one cell is counted, with no allowance", () => {
  const ref = rasterize([[KIND.media, 0, 0, 200, 80], [KIND.text, 200, 0, 200, 80]], { width: 400, bottom: 80, cell });
  const cand = rasterize([[KIND.media, 0, 0, 208, 80], [KIND.text, 208, 0, 192, 80]], { width: 400, bottom: 80, cell });
  const result = scoreMasks(ref, cand);
  assert.ok(result.score < 1 && result.score > 0.9, `score ${result.score}`);
});

test("a region passes only when every one of its bands does", () => {
  const bands = [[KIND.media, 600], [KIND.surface, 400], [KIND.media, 600]];
  const reference = site(["/"], bands);
  const candidate = site(["/"], bands);
  // The same page, except one band's picture swapped for text.
  const page = candidate.routes[0].viewports.desktop;
  page.boxes = page.boxes.map((box) => (box[0] === KIND.media && box[2] > 1000 ? [KIND.text, box[1], box[2], box[3], box[4]] : box));
  const outcome = auditSite(reference, candidate).routes[0].viewports.desktop.regions.body;
  assert.equal(outcome.passed, false);
  assert.ok(outcome.bands.some((band) => band.score < THRESHOLDS.body));
});

test("each alignment covers every row of both masks once in order", () => {
  const a = page([[KIND.media, 320], [KIND.surface, 240]]);
  const b = page([[KIND.media, 400], [KIND.surface, 200]]);
  const ref = rasterize(a.boxes, { width: 400, bottom: a.height, cell });
  const cand = rasterize(b.boxes, { width: 400, bottom: b.height, cell });
  const pairs = alignRows(ref, cand);
  assert.ok(pairs);
  assert.deepEqual([...new Set(pairs.map(([i]) => i))], [...Array(ref.rows).keys()]);
  assert.deepEqual([...new Set(pairs.map(([, j]) => j))], [...Array(cand.rows).keys()]);
  for (let k = 1; k < pairs.length; k += 1) {
    assert.ok(pairs[k][0] >= pairs[k - 1][0] && pairs[k][1] >= pairs[k - 1][1]);
  }
});

function capturedPage(bands, name) {
  const { width, height: vh } = VIEWPORTS[name];
  const built = page(bands, width);
  const header = { bottom: 80, overlay: false, fixed: false, links: 4 };
  const boxes = [[KIND.surface, 0, 0, width, 80], [KIND.mark, 16, 20, 120, 40], ...built.boxes.map(([k, x, y, w, h]) => [k, x, y + 80, w, h])];
  const total = built.height + 80 + 200;
  boxes.push([KIND.surface, 0, built.height + 80, width, 200]);
  return {
    width,
    height: total,
    viewportHeight: vh,
    boxes,
    header,
    footer: { top: built.height + 80 },
    sections: [],
    menu: { opened: false, boxes: boxes.filter(([, , y]) => y < vh) },
  };
}

function site(paths, bands) {
  return {
    routes: paths.map((path) => ({
      path,
      viewports: Object.fromEntries(Object.keys(VIEWPORTS).map((name) => [name, capturedPage(bands, name)])),
    })),
  };
}

test("the check passes a site that matches every route at every width", () => {
  const bands = [[KIND.media, 600], [KIND.surface, 400]];
  const result = auditSite(site(["/", "/menu"], bands), site(["/", "/menu"], bands));
  assert.equal(result.passed, true);
});

test("a route the reference lacks, one the site lacks, and a missing width all fail", () => {
  const bands = [[KIND.media, 600], [KIND.surface, 400]];
  const reference = site(["/", "/menu"], bands);
  const extra = auditSite(reference, site(["/", "/menu", "/notes"], bands));
  assert.equal(extra.passed, false);
  assert.equal(extra.routes.find((route) => route.path === "/notes").problem, "extra");
  const missing = auditSite(reference, site(["/"], bands));
  assert.equal(missing.passed, false);
  assert.equal(missing.routes.find((route) => route.path === "/menu").problem, "missing");
  const noPhone = site(["/", "/menu"], bands);
  delete noPhone.routes[1].viewports.phone;
  assert.equal(auditSite(reference, noPhone).passed, false);
  const notes = repairNotes(reference, site(["/", "/menu", "/notes"], bands), extra);
  assert.ok(notes.some((note) => note.includes("/notes")));
});

test("a body that is not the reference's fails and says which section", () => {
  const reference = site(["/"], [[KIND.media, 700], [KIND.surface, 500], [KIND.media, 600]]);
  const candidate = site(["/"], [[KIND.background, 500], [KIND.background, 500], [KIND.background, 500]]);
  const result = auditSite(reference, candidate);
  assert.equal(result.passed, false);
  assert.equal(result.routes[0].viewports.desktop.regions.body.passed, false);
  assert.equal(result.routes[0].viewports.desktop.regions.header.passed, true);
});

test("regions split the page at the header's foot and the footer's top", () => {
  const bounds = regionBounds({ height: 3000, viewportHeight: 900, header: { bottom: 120 }, footer: { top: 2700 } });
  assert.deepEqual(bounds.header, [0, 120]);
  assert.deepEqual(bounds.body, [120, 2700]);
  assert.deepEqual(bounds.footer, [2700, 3000]);
  assert.deepEqual(bounds.menu, [0, 900]);
});

test("a block summary counts what it holds", () => {
  const summary = summarizeBlock([[KIND.media, 0, 0, 400, 300], [KIND.heading, 200, 40, 100, 30], [KIND.control, 200, 100, 80, 40]], 0, 300, 400);
  assert.equal(summary.media, 1);
  assert.equal(summary.fullBleed, true);
  assert.equal(summary.headingLines, 1);
  assert.equal(summary.controls, 1);
});

test("mask images encode as PNG", async () => {
  const a = rasterize([[KIND.media, 0, 0, 40, 40]], { width: 80, bottom: 80, cell });
  const png = await encodePng(pairImage(a, a));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
