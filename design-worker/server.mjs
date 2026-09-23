// The design research worker: the reference a site's design comes from.
//
// A new site's reference is found once: Brave searches four cities for
// businesses like the member's, candidate sites are inspected in Chromium and
// the best one is chosen. A site that already has one is researched again at
// the same address with no search. Then the page discovery agent chooses the
// reference's pages -- five at most (discover.mjs) -- and SkillUI Ultra
// extracts its design (skillui.mjs). The whole `.skill` package is uploaded to
// Convex, and the extract, its foundation stylesheet and the chosen pages go
// back with it. Every stage streams as it happens; any failure fails the job,
// and nothing is ever made up in place of a reference.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright';
import { discoverPages, publicUrl } from './discover.mjs';
import { extractPrompt, foundationCss, runSkillUI } from './skillui.mjs';
import { imagesFromZip, loadPackage, renderCompare, shotsForModel } from './visual.mjs';

const CITIES = ['Los Angeles', 'New York', 'San Diego', 'Miami'];
const DIRECTORY = /(?:google|yelp|facebook|instagram|linkedin|tripadvisor|pinterest|tiktok|yellowpages|mapquest|thumbtack|angi)\./i;
const PORT = Number(process.env.PORT || 8080);

function category(offer) {
  return String(offer).replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|our|with|that|have|from|we|are|provide|offering|website|business)$/i.test(w))
    .slice(0, 8).join(' ').slice(0, 100);
}

async function search(categoryText, references, emit) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY is required for city research');
  const found = new Map();
  const explicit = String(references).match(/https?:\/\/[^\s,<>]+/gi) || [];
  for (const raw of explicit.slice(0, 3)) {
    const url = publicUrl(raw);
    if (url) found.set(new URL(url).hostname, { url, city: 'Provided by user', priority: 4 });
  }
  for (const city of CITIES) {
    emit('searching', { city });
    const query = `${categoryText} ${city} business official website`;
    const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
    const response = await fetch(endpoint, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`City search failed with HTTP ${response.status}`);
    const body = await response.json();
    for (const hit of (body.web?.results || []).slice(0, 7)) {
      const url = publicUrl(hit.url);
      if (!url || DIRECTORY.test(new URL(url).hostname)) continue;
      const host = new URL(url).hostname;
      if (!found.has(host)) found.set(host, { url, city, priority: 0, title: hit.title || '', description: hit.description || '' });
    }
  }
  return [...found.values()];
}

async function inspect(browser, entry, feel) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.route('**/*', route => publicUrl(route.request().url()) ? route.continue() : route.abort());
    const response = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    if (!response || response.status() >= 400 || !publicUrl(page.url())) throw new Error('Page unavailable');
    await page.waitForTimeout(900);
    const detail = await page.evaluate(() => ({
      title: document.title.slice(0, 140),
      description: document.querySelector('meta[name="description"]')?.content?.slice(0, 220) || '',
      headings: [...document.querySelectorAll('h1,h2')].slice(0, 10).map(n => n.textContent.trim().slice(0, 80)),
      sections: document.querySelectorAll('main section, main article, body > section').length,
      nav: [...document.querySelectorAll('header a, nav a')].slice(0, 30).map(a => ({ text: a.textContent.trim().slice(0, 48), href: a.href })),
      footer: [...document.querySelectorAll('footer a')].slice(0, 30).map(a => ({ text: a.textContent.trim().slice(0, 48), href: a.href })),
      images: document.querySelectorAll('main img').length,
      bodyFont: getComputedStyle(document.body).fontFamily,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    const links = [...detail.nav, ...detail.footer].filter(x => x.href && new URL(x.href).origin === new URL(page.url()).origin);
    const categoryWords = category(feel.offer || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const description = [detail.title, detail.description, ...detail.headings].join(' ').toLowerCase();
    const matches = categoryWords.filter(word => description.includes(word)).length;
    if (entry.priority < 4 && categoryWords.length && !matches) throw new Error('Different business category');
    const score = entry.priority * 100 + Math.min(detail.sections, 9) * 2 + Math.min(detail.images, 8) +
      Math.min(links.length, 12) + (detail.footer.length ? 5 : 0) + (detail.headings.length > 2 ? 5 : 0) +
      Math.min(matches, 3) * 8 + (String(feel.tone).toLowerCase().includes('bold') && detail.images > 2 ? 2 : 0);
    return { ...entry, url: page.url(), detail, score };
  } finally { await context.close(); }
}

// The inspection browser closes before SkillUI starts its own Chromium, and
// the package streams from disk to Convex rather than through Node's memory.
// The search, the page loads and the upload keep the limits they always had,
// and nothing else is timed: the job lasts as long as the request that asked
// for it, and `signal` stops whatever is still running -- the browser, or
// SkillUI -- once that request is closed.
async function research(input, emit, signal) {
  const known = input.referenceUrl ? publicUrl(input.referenceUrl) : null;
  if (input.referenceUrl && !known) throw new Error('The saved design reference is not a public web address');
  let candidates = [];
  if (!known) {
    const categoryText = category(input.offer);
    if (!categoryText) throw new Error('A business category is needed for design research');
    candidates = await search(categoryText, input.references, emit);
  }
  let chosenUrl = known;
  let routes;
  const browser = await chromium.launch({ headless: true });
  const closeBrowser = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', closeBrowser, { once: true });
  try {
    if (!chosenUrl) {
      const measured = [];
      const byCity = new Map();
      const shortlist = candidates.filter(candidate => {
        const count = byCity.get(candidate.city) || 0;
        byCity.set(candidate.city, count + 1);
        return count < 3;
      });
      for (const candidate of shortlist) {
        emit('candidate', { city: candidate.city, domain: new URL(candidate.url).hostname });
        try { measured.push(await inspect(browser, candidate, { tone: input.feel, offer: input.offer })); } catch { /* Try another site. */ }
      }
      measured.sort((a, b) => b.score - a.score);
      if (!measured[0]) throw new Error('No reference site could be inspected');
      chosenUrl = measured[0].url;
    }
    routes = await discoverPages(browser, chosenUrl, { emit });
  } finally {
    signal?.removeEventListener('abort', closeBrowser);
    await browser.close();
  }
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-design-'));
  try {
    const name = `reference-${new URL(chosenUrl).hostname.replace(/[^a-z0-9-]/gi, '-')}`.slice(0, 70);
    const pkg = await runSkillUI(chosenUrl, out, name, { emit, signal });
    const prompt = extractPrompt({ source: chosenUrl, routes, pkg });
    const foundation = foundationCss({ source: chosenUrl, tokens: pkg.tokens });
    emit('uploading', { pages: routes.length });
    const { size } = await fs.stat(pkg.skillFile);
    const upload = await fetch(input.uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'content-length': String(size) },
      body: createReadStream(pkg.skillFile), duplex: 'half',
      signal: signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000),
    });
    if (!upload.ok) throw new Error(`Design package upload failed (${upload.status})`);
    const { storageId } = await upload.json();
    if (!storageId) throw new Error('Design package upload returned no storage ID');
    return { storageId, referenceUrl: chosenUrl, prompt, foundation, inspectedPages: pkg.screens, routes: routes.map(route => route.path) };
  } finally { await fs.rm(out, { recursive: true, force: true }); }
}

const LIMITS = { '/research': 16000, '/shots': 16000, '/visual': 1500000 };
const PARTS = new Set(['header', 'body1', 'body2', 'footer']);

function valid(input) {
  return input.uploadUrl?.startsWith('https://') && (Boolean(input.offer) || typeof input.referenceUrl === 'string');
}

function authorized(req) {
  const expected = Buffer.from(process.env.DESIGN_WORKER_TOKEN || '');
  const actual = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.method !== 'POST' || !LIMITS[pathname]) { res.writeHead(404); res.end(); return; }
  if (!authorized(req)) { res.writeHead(401); res.end(); return; }
  const raw = await readBody(req, LIMITS[pathname]);
  if (!raw) { res.writeHead(413); res.end(); return; }
  let input;
  try { input = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
  if (pathname === '/shots' || pathname === '/visual') {
    const packageUrl = httpsUrl(input.packageUrl);
    const part = PARTS.has(input.part) ? input.part : null;
    const pagePath = typeof input.path === 'string' && input.path.startsWith('/') ? input.path.slice(0, 80) : null;
    if (!packageUrl || !part || !pagePath) { res.writeHead(400); res.end(); return; }
    if (pathname === '/visual' && (typeof input.html !== 'string' || !input.html.trim())) { res.writeHead(400); res.end(); return; }
    const job = new AbortController();
    req.on('close', () => { if (!res.writableFinished) job.abort(); });
    try {
      const decoded = imagesFromZip(await loadPackage(packageUrl), part, pagePath);
      const body = pathname === '/shots'
        ? { shots: shotsForModel(decoded) }
        : await renderCompare(input.html, decoded, part, Number(input.maxRatio), job.signal);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ pass: false, compared: false, ratio: 1, fixes: [String(error.message || error).slice(0, 180)] }));
    }
    return;
  }
  try {
    if (!valid(input)) throw new Error('Invalid request');
  } catch { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  res.flushHeaders();
  // Once Convex closes the connection, nobody is waiting on the job: whatever
  // is still running stops, rather than any clock here deciding it.
  const job = new AbortController();
  res.on('close', () => { if (!res.writableFinished) job.abort(); });
  const emit = (phase, detail = {}) => { if (!job.signal.aborted) res.write(JSON.stringify({ type: 'progress', phase, detail }) + '\n'); };
  try {
    res.write(JSON.stringify({ type: 'complete', ...await research(input, emit, job.signal) }) + '\n');
  } catch (error) {
    res.write(JSON.stringify({ type: 'error', reason: String(error.message || error).slice(0, 180) }) + '\n');
  }
  res.end();
});
server.listen(PORT, '0.0.0.0');
