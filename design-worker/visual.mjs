// Pixel gate for a crew part.
//
// SkillUI Ultra stores the reference screenshots inside the `.skill` zip
// (`screens/scroll`, `screens/pages`, `screens/sections`). This module pulls
// the shots that belong to one part, and — when asked — renders the builder's
// HTML in Chromium and counts differing pixels against those shots.
//
// A part passes only when every measured width is at or under the ratio Convex
// sends (0.1% unless BUILDER_VISUAL_MAX_DIFF says otherwise). Nothing here
// decides from a caption or a model's description.
import zlib from "node:zlib";

const WIDTHS = [1440, 390];
const DEFAULT_MAX = 0.001;

export function selectShotPaths(paths, part, pagePath) {
  const images = paths.filter((name) => /\/screens\/.+\.(png|jpe?g|webp)$/i.test(name) || /\/screenshots\/.+\.(png|jpe?g|webp)$/i.test(name));
  const png = images.filter((name) => /\.png$/i.test(name));
  const pool = png.length ? png : images;
  const slug = pagePath === "/" ? "home" : String(pagePath ?? "/").replace(/^\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const pageShots = pool.filter((name) => /\/pages\//i.test(name) && name.toLowerCase().includes(slug));
  const frames = { header: ["scroll-000"], body1: ["scroll-000", "scroll-017", "scroll-033"], body2: ["scroll-050", "scroll-067", "scroll-083"], footer: ["scroll-100"] }[part] ?? [];
  const find = (frame) => pool.find((name) => new RegExp(`${frame}\\.`, "i").test(name));
  const ordered = [
    ...frames.map(find),
    ...pageShots,
    ...pool.filter((name) => /\/sections\//i.test(name)).slice(0, 2),
  ];
  const seen = new Set();
  const picked = [];
  for (const name of ordered) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    picked.push(name);
    if (picked.length === 3) break;
  }
  if (!picked.length) {
    const fallback = pool.find((name) => /\/pages\//i.test(name)) ?? pool[0];
    if (fallback) picked.push(fallback);
  }
  return picked;
}

// Where in a full-page shot this part lives. Scroll frames are already a
// viewport; a header uses the top of the first frame and a footer the bottom
// of the last. Section clips are the section.
export function bandFor(name, part) {
  const file = name.toLowerCase();
  if (/\/sections\//.test(file)) return [0, 1];
  if (/scroll-000/.test(file) && part === "header") return [0, 0.22];
  if (/scroll-100/.test(file) && part === "footer") return [0.7, 1];
  if (/scroll-/.test(file)) return [0, 1];
  if (part === "header") return [0, 0.14];
  if (part === "body1") return [0.1, 0.55];
  if (part === "body2") return [0.45, 0.9];
  if (part === "footer") return [0.86, 1];
  return [0, 1];
}

export function packZip(files, method = 0) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = Buffer.from(raw);
    const nameBuf = Buffer.from(name);
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method === 8 ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, stored]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method === 8 ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + stored.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < total && offset + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/") || compSize === 0xffffffff) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    if (comp.length < compSize) continue;
    const data = method === 0 ? Buffer.from(comp) : method === 8 ? zlib.inflateRawSync(comp) : null;
    if (data) files.set(name, data);
  }
  return files;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba);
  for (let y = 0; y < height; y++) {
    raw[(stride + 1) * y] = 0;
    src.copy(raw, (stride + 1) * y + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((byte, i) => buf[i] !== byte)) throw new Error("not a png");
  let offset = 8;
  let width = 0;
  let height = 0;
  let color = -1;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString("ascii");
    const data = buf.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported png");
      color = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height || (color !== 2 && color !== 6)) throw new Error("unsupported png");
  if (width * height > 25_000_000) throw new Error("png too large");
  const bpp = color === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("truncated png");
  const out = Buffer.alloc(width * height * 4);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      const x = row[i];
      if (filter === 0) recon[i] = x;
      else if (filter === 1) recon[i] = (x + left) & 255;
      else if (filter === 2) recon[i] = (x + up) & 255;
      else if (filter === 3) recon[i] = (x + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) recon[i] = (x + paeth(left, up, ul)) & 255;
      else throw new Error("bad png filter");
    }
    prev = recon;
    const dest = out.subarray(y * width * 4, (y + 1) * width * 4);
    for (let x = 0; x < width; x++) {
      const di = x * 4;
      if (bpp === 4) {
        dest[di] = recon[x * 4];
        dest[di + 1] = recon[x * 4 + 1];
        dest[di + 2] = recon[x * 4 + 2];
        dest[di + 3] = recon[x * 4 + 3];
      } else {
        dest[di] = recon[x * 3];
        dest[di + 1] = recon[x * 3 + 1];
        dest[di + 2] = recon[x * 3 + 2];
        dest[di + 3] = 255;
      }
    }
  }
  return { width, height, rgba: out };
}

export function resizeRgba(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

export function cropRgba(src, sw, sh, y0, y1) {
  const top = Math.max(0, Math.min(sh - 1, Math.floor(sh * y0)));
  const bot = Math.max(top + 1, Math.min(sh, Math.ceil(sh * y1)));
  return { rgba: Buffer.from(src.subarray(top * sw * 4, bot * sw * 4)), width: sw, height: bot - top };
}

// Exact RGB. One channel off counts the pixel. Alpha is ignored.
export function diffRatio(a, b) {
  const total = Math.floor(Math.min(a.length, b.length) / 4);
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) differing += 1;
  }
  return { differing, total, ratio: total ? differing / total : 1 };
}

export function compareShot(reference, rendered, band) {
  const crop = cropRgba(reference.rgba, reference.width, reference.height, band[0], band[1]);
  const dw = rendered.width;
  const dh = rendered.height;
  const scaled = resizeRgba(crop.rgba, crop.width, crop.height, dw, dh);
  return diffRatio(scaled, rendered.rgba);
}

function visualFix(row, maxRatio) {
  const pct = (row.ratio * 100).toFixed(3);
  const cap = (maxRatio * 100).toFixed(3);
  return `Pixel gate failed at ${row.width}px against ${row.shot}: ${row.differing} of ${row.total} pixels differ (${pct}%). The part is kept only at or under ${cap}%. Match the attached SkillUI screenshot — same columns, gaps, heights, type scale, alignment and colour. Do not claim a match; change the HTML and CSS until the pixels line up.`;
}

const zipCache = new Map();

export async function loadPackage(url) {
  const hit = zipCache.get(url);
  if (hit && Date.now() - hit.at < 600000) return hit.buffer;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`reference package answered ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 22 || buffer.length > 80_000_000) throw new Error("reference package is not a usable zip");
  zipCache.set(url, { at: Date.now(), buffer });
  if (zipCache.size > 4) {
    const oldest = [...zipCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) zipCache.delete(oldest[0]);
  }
  return buffer;
}

export function imagesFromZip(buffer, part, pagePath) {
  const files = readZip(buffer);
  const picked = selectShotPaths([...files.keys()], part, pagePath);
  const decoded = [];
  for (const name of picked) {
    const bytes = files.get(name);
    if (!bytes || !/\.png$/i.test(name)) continue;
    try { decoded.push({ name, ...decodePng(bytes) }); } catch { /* skip a shot that is not a plain png */ }
  }
  return decoded;
}

export function shotsForModel(decoded) {
  return decoded.slice(0, 3).map((shot) => {
    const dw = Math.min(800, shot.width);
    const dh = Math.max(1, Math.min(1000, Math.round((shot.height * dw) / shot.width)));
    const rgba = resizeRgba(shot.rgba, shot.width, shot.height, dw, dh);
    return { label: shot.name, mediaType: "image/png", base64: encodePng(dw, dh, rgba).toString("base64") };
  });
}

async function shotPage(browser, html, width, signal) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  try {
    if (signal?.aborted) throw new Error("visual gate closed");
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || /fontshare\.com|fonts\.gstatic\.com|fonts\.googleapis\.com/i.test(url)) return route.continue();
      if (/^https?:/i.test(url)) return route.abort();
      return route.continue();
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(350);
    const height = await page.evaluate(() => Math.min(Math.max(document.documentElement.scrollHeight, 1), 2200));
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  } finally {
    await page.close().catch(() => {});
  }
}

// Renders `html` at phone and desktop widths and diffs each against the
// closest reference shot. Passes only when both widths are within maxRatio.
export async function renderCompare(html, decoded, part, maxRatio = DEFAULT_MAX, signal) {
  if (!decoded.length) {
    return {
      pass: false,
      compared: false,
      ratio: 1,
      fixes: ["No SkillUI reference PNG for this part was in the package (screens/scroll, screens/pages or screens/sections). The part is not complete."],
    };
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const stop = () => { browser.close().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const rows = [];
    for (const width of WIDTHS) {
      const rendered = decodePng(await shotPage(browser, html, width, signal));
      let best = null;
      for (const ref of decoded) {
        const result = compareShot(ref, rendered, bandFor(ref.name, part));
        if (!best || result.ratio < best.ratio) best = { ...result, shot: ref.name, width };
      }
      rows.push(best);
    }
    const cap = Number.isFinite(maxRatio) && maxRatio >= 0 && maxRatio <= 1 ? maxRatio : DEFAULT_MAX;
    const failing = rows.filter((row) => row.ratio > cap);
    const worst = rows.reduce((a, b) => (a.ratio >= b.ratio ? a : b));
    return {
      pass: failing.length === 0,
      compared: true,
      differing: worst.differing,
      total: worst.total,
      ratio: worst.ratio,
      maxRatio: cap,
      width: worst.width,
      shot: worst.shot,
      fixes: failing.map((row) => visualFix(row, cap)),
    };
  } finally {
    signal?.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}
