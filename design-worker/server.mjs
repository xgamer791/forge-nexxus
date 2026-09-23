import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright';

const CITIES = ['Los Angeles', 'New York', 'San Diego', 'Miami'];
const BLOCKED = /(?:^|\.)(?:localhost|local|internal|test)$/i;
const DIRECTORY = /(?:google|yelp|facebook|instagram|linkedin|tripadvisor|pinterest|tiktok|yellowpages|mapquest|thumbtack|angi)\./i;
const PORT = Number(process.env.PORT || 8080);

function publicUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port && !['80', '443'].includes(u.port)) return null;
    if (BLOCKED.test(host) || host === 'localhost' || host === '0.0.0.0' || host === '::1' ||
        /^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^(?:fc|fd|fe80)/i.test(host) || !host.includes('.')) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

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

async function capture(browser, chosen, dir, emit) {
  const origin = new URL(chosen.url).origin;
  // Inspect one of each useful layout, not every navigation link. The home
  // capture below also records both viewport and menu states.
  const candidates = [...chosen.detail.nav, ...chosen.detail.footer];
  const roles = [
    ['services', /services?|solutions?|offerings?|products?|collections?|shop|menu/i],
    ['detail', /service|product|treatment|practice|item|portfolio|work|project/i],
    ['about', /about|our.story|team|who.we.are/i],
    ['contact', /contact|location|visit|find.us/i],
    ['journal', /blog|journal|insight|news|resources?/i],
    ['booking', /book|appointment|reserve|quote|order|pricing/i],
    ['other', /./],
  ];
  const seen = new Set([chosen.url.replace(/\/$/, '')]);
  const pages = [{ url: chosen.url, role: 'home' }];
  for (const [role, pattern] of roles) {
    const found = candidates.find(link => {
      const url = publicUrl(link.href);
      if (!url || new URL(url).origin !== origin || seen.has(url.replace(/\/$/, ''))) return false;
      return pattern.test(`${link.text} ${new URL(url).pathname.replace(/[-_/]/g, ' ')}`);
    });
    if (found) {
      pages.push({ url: found.href, role });
      seen.add(found.href.replace(/\/$/, ''));
    }
  }
  const inventory = [];
  const shots = path.join(dir, 'screens', 'pages');
  await fs.mkdir(shots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  for (const [index, entry] of pages.entries()) {
    emit('inspecting', { page: index + 1, total: pages.length });
    const page = await context.newPage();
    try {
      await page.route('**/*', route => publicUrl(route.request().url()) ? route.continue() : route.abort());
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 16000 });
      const data = await page.evaluate(() => ({
        path: location.pathname, title: document.title.slice(0, 100),
        sections: [...document.querySelectorAll('main > section, main > article, main > div')].slice(0, 18).map(node => ({
          tag: node.tagName.toLowerCase(), className: String(node.className).slice(0, 100),
          heading: node.querySelector('h1,h2,h3')?.textContent?.trim().slice(0, 70) || '',
          layout: getComputedStyle(node).display,
        })),
        header: document.querySelector('header')?.getBoundingClientRect().height || 0,
        footer: document.querySelector('footer')?.getBoundingClientRect().height || 0,
      }));
      inventory.push({ ...data, role: entry.role });
      if (index === 0) {
        await page.screenshot({ path: path.join(shots, 'reference-desktop-home.png'), fullPage: true });
        const menu = page.locator('header button[aria-expanded], nav button[aria-expanded]').first();
        if (await menu.count()) {
          await menu.click().catch(() => {});
          await page.screenshot({ path: path.join(shots, 'reference-desktop-menu.png') });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: path.join(shots, 'reference-mobile-home.png'), fullPage: true });
        const mobileMenu = page.locator('header button[aria-expanded], nav button[aria-expanded], button[aria-label*="menu" i]').first();
        if (await mobileMenu.count()) {
          await mobileMenu.click().catch(() => {});
          await page.screenshot({ path: path.join(shots, 'reference-mobile-menu.png') });
        }
      }
    } catch { /* A failed page stays out of the measured inventory. */ }
    finally { await page.close(); }
  }
  await context.close();
  if (inventory.length === 0) throw new Error('No reference pages could be inspected');
  return inventory;
}

async function runSkillUI(url, out, name, emit) {
  emit('skillui', { mode: 'ultra', screens: 12 });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skillui-home-'));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'skillui'),
        ['--url', url, '--mode', 'ultra', '--screens', '12', '--name', name, '--out', out],
        { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`SkillUI ultra failed (${code}): ${tail.replace(/\x1b\[[0-9;]*m/g, '').slice(-400)}`)));
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

async function research(input, emit) {
  const categoryText = category(input.offer);
  if (!categoryText) throw new Error('A business category is needed for design research');
  const candidates = await search(categoryText, input.references, emit);
  const browser = await chromium.launch({ headless: true });
  let chosen;
  try {
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
    chosen = measured[0];
    if (!chosen) throw new Error('No reference site could be inspected');
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-design-'));
    try {
      const name = `reference-${new URL(chosen.url).hostname.replace(/[^a-z0-9-]/gi, '-')}`.slice(0, 70);
      const dir = path.join(out, `${name}-design`);
      const inventory = await capture(browser, chosen, dir, emit);
      await runSkillUI(chosen.url, out, name, emit);
      const skill = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      const design = await fs.readFile(path.join(dir, 'references', 'DESIGN.md'), 'utf8');
      const layout = await fs.readFile(path.join(dir, 'references', 'LAYOUT.md'), 'utf8');
      await fs.access(path.join(dir, 'references', 'ANIMATIONS.md'));
      // The model uses this derivative of the persisted SkillUI package. The
      // typography rules in Design God override sampled fonts and font URLs.
      const reference = JSON.stringify({ source: chosen.url, pages: inventory, nav: chosen.detail.nav, footer: chosen.detail.footer });
      const prompt = `SkillUI ultra design reference for this site. Use this for the shared shell, layout and component rhythm on every page. Do not copy source text, images, logos, addresses or brand identity. Write original copy from the user's brief and request original subject images through forge-image. DESIGN_GOD's Type section overrides all fonts and typography below; choose only Fontshare fonts.\n\nSite structure and inspected pages:\n${reference.slice(0, 13000)}\n\nSkillUI SKILL.md:\n${skill.replace(/^.*(?:fonts\.googleapis\.com|Google Fonts|google fonts).*$/gim, '').slice(0, 42000)}\n\nDesign tokens:\n${design.replace(/^.*(?:fonts\.googleapis\.com|Google Fonts|google fonts).*$/gim, '').slice(0, 14000)}\n\nLayout measurements:\n${layout.slice(0, 5000)}`.slice(0, 79000);
      if (!skill.includes('Design System') || !inventory.length || !layout.trim()) throw new Error('SkillUI ultra produced no usable design reference');
      emit('uploading', { pages: inventory.length });
      const zip = await fs.readFile(path.join(dir, `${name}-design.skill`));
      const upload = await fetch(input.uploadUrl, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip, signal: AbortSignal.timeout(45000) });
      if (!upload.ok) throw new Error(`Design package upload failed (${upload.status})`);
      const { storageId } = await upload.json();
      if (!storageId) throw new Error('Design package upload returned no storage ID');
      return { storageId, referenceUrl: chosen.url, prompt, inspectedPages: inventory.length };
    } finally { await fs.rm(out, { recursive: true, force: true }); }
  } finally { await browser.close(); }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.method !== 'POST' || req.url !== '/research') { res.writeHead(404); res.end(); return; }
  const expected = Buffer.from(process.env.DESIGN_WORKER_TOKEN || '');
  const actual = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(401); res.end(); return;
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16000) { res.writeHead(413); res.end(); return; } }
  let input;
  try {
    input = JSON.parse(raw);
    if (!input.offer || !input.uploadUrl?.startsWith('https://')) throw new Error('Invalid research request');
  } catch { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  res.flushHeaders();
  const emit = (phase, detail = {}) => res.write(JSON.stringify({ type: 'progress', phase, detail }) + '\n');
  try { res.write(JSON.stringify({ type: 'complete', ...await research(input, emit) }) + '\n'); }
  catch (error) { res.write(JSON.stringify({ type: 'error', reason: String(error.message || error).slice(0, 180) }) + '\n'); }
  res.end();
});
server.listen(PORT, '0.0.0.0');
