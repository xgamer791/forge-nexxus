import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright';
import { publicUrl } from './capture.mjs';
import { FORMAT, auditBuild, captureReference } from './reference.mjs';

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

// Each job keeps its screenshots and mask images on this machine, for checking
// a run by eye. Only the newest few are kept.
const ARTIFACTS = path.join(os.tmpdir(), 'forge-design');
const KEEP_JOBS = 12;

async function jobFolder(kind) {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  const names = (await fs.readdir(ARTIFACTS)).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_JOBS + 1))) {
    await fs.rm(path.join(ARTIFACTS, old), { recursive: true, force: true });
  }
  const dir = path.join(ARTIFACTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// A new site's reference is found once through Brave; a site that already has
// one is measured again at the same address with no search at all.
async function research(input, emit, artifacts) {
  const known = input.referenceUrl ? publicUrl(input.referenceUrl) : null;
  if (input.referenceUrl && !known) throw new Error('The saved design reference is not a public web address');
  let candidates = [];
  if (!known) {
    const categoryText = category(input.offer);
    if (!categoryText) throw new Error('A business category is needed for design research');
    candidates = await search(categoryText, input.references, emit);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    let chosenUrl = known;
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
    const { reference, prompt } = await captureReference(browser, chosenUrl, { emit, artifacts });
    emit('uploading', { pages: reference.routes.length });
    const upload = await fetch(input.uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reference),
      signal: AbortSignal.timeout(45000),
    });
    if (!upload.ok) throw new Error(`Design reference upload failed (${upload.status})`);
    const { storageId } = await upload.json();
    if (!storageId) throw new Error('Design reference upload returned no storage ID');
    return { storageId, referenceUrl: chosenUrl, prompt, inspectedPages: reference.routes.length, routes: reference.routes.map(route => route.path), artifacts };
  } finally { await browser.close(); }
}

// The layout check: the site's pages against the measured reference, every
// route at every width. Nothing about it is a judgement call.
async function audit(input, emit, artifacts) {
  const source = publicUrl(input.reference);
  if (!source || !source.startsWith('https://')) throw new Error('The design reference address is not usable');
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`The design reference could not be read (${response.status})`);
  const reference = await response.json();
  if (reference?.format !== FORMAT || !Array.isArray(reference.routes) || !reference.routes.length) {
    throw new Error('The saved design reference is not a measured reference');
  }
  const browser = await chromium.launch({ headless: true });
  try { return { ...await auditBuild(browser, reference, input.pages, { emit, artifacts }), artifacts }; }
  finally { await browser.close(); }
}

const LIMITS = { '/research': 16000, '/audit': 16 * 1024 * 1024 };

function valid(route, input) {
  if (route === '/research') {
    return input.uploadUrl?.startsWith('https://') && (Boolean(input.offer) || typeof input.referenceUrl === 'string');
  }
  return typeof input.reference === 'string' && Array.isArray(input.pages) && input.pages.length > 0 &&
    input.pages.every(page => typeof page?.path === 'string' && typeof page?.html === 'string');
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.method !== 'POST' || !(req.url in LIMITS)) { res.writeHead(404); res.end(); return; }
  const expected = Buffer.from(process.env.DESIGN_WORKER_TOKEN || '');
  const actual = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(401); res.end(); return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS[req.url]) { res.writeHead(413); res.end(); return; }
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!valid(req.url, input)) throw new Error('Invalid request');
  } catch { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  res.flushHeaders();
  const emit = (phase, detail = {}) => res.write(JSON.stringify({ type: 'progress', phase, detail }) + '\n');
  try {
    const artifacts = await jobFolder(req.url.slice(1));
    const result = req.url === '/research' ? await research(input, emit, artifacts) : await audit(input, emit, artifacts);
    res.write(JSON.stringify({ type: 'complete', ...result }) + '\n');
  } catch (error) {
    res.write(JSON.stringify({ type: 'error', reason: String(error.message || error).slice(0, 180) }) + '\n');
  }
  res.end();
});
server.listen(PORT, '0.0.0.0');
