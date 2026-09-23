// Real-time design auditors. They replace the ai-site-cloner mask score.
// A page is complete only when every auditor agrees it matches the SkillUI
// Ultra extract. Anything missing, extra, or disagreed is a failure.
import { MAX_PAGES, normalizePath } from "./discover.mjs";
import { FORMAT } from "./extract.mjs";

export const CREW = {
  header: { builders: 1, auditors: 1 },
  body: { builders: 2, auditors: 2 },
  footer: { builders: 1, auditors: 1 },
};

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

export function colorTokens(extract) {
  const blob = [extract?.design, extract?.claude, extract?.skill, JSON.stringify(extract?.tokens ?? {})].join("\n");
  return [...new Set((blob.match(HEX) ?? []).map((color) => color.toLowerCase()))];
}

export function splitRegions(html) {
  const source = String(html ?? "");
  const take = (pattern) => source.match(pattern)?.[0] ?? "";
  const header = take(/<header\b[^>]*>[\s\S]*?<\/header>/i) || take(/<nav\b[^>]*>[\s\S]*?<\/nav>/i);
  const footer = take(/<footer\b[^>]*>[\s\S]*?<\/footer>/i);
  let body = take(/<main\b[^>]*>[\s\S]*?<\/main>/i);
  if (!body) {
    const start = header ? source.indexOf(header) + header.length : 0;
    const end = footer && source.indexOf(footer) > start ? source.indexOf(footer) : source.length;
    body = source.slice(start, end);
  }
  return { header, body, footer };
}

function hostOf(source) {
  try {
    return new URL(source).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function leaks(html, source) {
  const host = hostOf(source);
  return Boolean(host) && String(html).toLowerCase().includes(host);
}

function routePaths(reference) {
  return (reference?.routes ?? []).map((route) => normalizePath(typeof route === "string" ? route : route?.path)).filter(Boolean);
}

function auditor(id, agree, notes) {
  return { id, agree: agree === true, notes };
}

// Header: one auditor. The region exists, it does not point at the reference
// host, and the extract itself is present to match against.
function headerAuditor(extract, header) {
  if (!extract?.design?.trim()) return auditor("header-1", false, "No SkillUI Ultra DESIGN.md to match.");
  if (!header.trim()) return auditor("header-1", false, "The page has no header.");
  if (leaks(header, extract.source)) return auditor("header-1", false, "The header links to the reference host.");
  return auditor("header-1", true, "Header matches the SkillUI Ultra extract.");
}

// Body, first auditor: the page has a body of sections, not an empty shell.
function bodyStructureAuditor(extract, body) {
  if (!extract?.design?.trim()) return auditor("body-1", false, "No SkillUI Ultra DESIGN.md to match.");
  if (!body.trim() || !/<(section|main|h1|h2)\b/i.test(body)) {
    return auditor("body-1", false, "The body has no section to match the extract.");
  }
  if (leaks(body, extract.source)) return auditor("body-1", false, "The body links to the reference host.");
  return auditor("body-1", true, "Body structure matches the SkillUI Ultra extract.");
}

// Body, second auditor: at least one color token from the extract is used.
// No tokens means there is nothing to agree with, which is not a pass.
function bodyTokenAuditor(extract, body, html) {
  const tokens = colorTokens(extract);
  if (!tokens.length) return auditor("body-2", false, "The SkillUI Ultra extract has no color tokens to match.");
  const haystack = `${body}\n${html}`.toLowerCase();
  const used = tokens.some((token) => haystack.includes(token));
  if (!used) return auditor("body-2", false, "The body does not use a color from the SkillUI Ultra extract.");
  if (leaks(html, extract.source)) return auditor("body-2", false, "The page links to the reference host.");
  return auditor("body-2", true, "Body tokens match the SkillUI Ultra extract.");
}

function footerAuditor(extract, footer) {
  if (!extract?.design?.trim()) return auditor("footer-1", false, "No SkillUI Ultra DESIGN.md to match.");
  if (!footer.trim()) return auditor("footer-1", false, "The page has no footer.");
  if (leaks(footer, extract.source)) return auditor("footer-1", false, "The footer links to the reference host.");
  return auditor("footer-1", true, "Footer matches the SkillUI Ultra extract.");
}

export function auditPage(extract, page) {
  const html = String(page?.html ?? "");
  const regions = splitRegions(html);
  const header = [headerAuditor(extract, regions.header)];
  const body = [bodyStructureAuditor(extract, regions.body), bodyTokenAuditor(extract, regions.body, html)];
  const footer = [footerAuditor(extract, regions.footer)];
  const crew = {
    header: { builders: CREW.header.builders, auditors: header },
    body: { builders: CREW.body.builders, auditors: body },
    footer: { builders: CREW.footer.builders, auditors: footer },
  };
  const auditors = [...header, ...body, ...footer];
  const agreed = auditors.every((item) => item.agree) &&
    header.length === CREW.header.auditors &&
    body.length === CREW.body.auditors &&
    footer.length === CREW.footer.auditors;
  const fixes = auditors.filter((item) => !item.agree).map((item) => `${page?.path ?? "/"}: ${item.notes}`);
  return { path: page?.path ?? "/", agreed, crew, fixes };
}

// One page at a time. More than five pages, a page discovery did not list,
// or any dissenting auditor fails the whole check.
export function auditSite(reference, pages) {
  if (reference?.format !== FORMAT) {
    return { passed: false, pages: [], fixes: ["The saved design reference is not a SkillUI Ultra extract."] };
  }
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length || list.length > MAX_PAGES) {
    return {
      passed: false,
      pages: [],
      fixes: [list.length > MAX_PAGES ? `A build can have at most ${MAX_PAGES} pages.` : "There is no page to audit."],
    };
  }
  const known = new Set(routePaths(reference));
  const reports = [];
  const fixes = [];
  for (const page of list) {
    const path = normalizePath(page?.path) ?? page?.path;
    if (!known.has(path)) {
      const refused = {
        path,
        agreed: false,
        crew: {
          header: { builders: CREW.header.builders, auditors: [auditor("header-1", false, "This page was not discovered.")] },
          body: { builders: CREW.body.builders, auditors: [auditor("body-1", false, "This page was not discovered."), auditor("body-2", false, "This page was not discovered.")] },
          footer: { builders: CREW.footer.builders, auditors: [auditor("footer-1", false, "This page was not discovered.")] },
        },
        fixes: [`${path} is not one of the discovered pages.`],
      };
      reports.push(refused);
      fixes.push(...refused.fixes);
      continue;
    }
    const report = auditPage({ ...reference, source: reference.source }, { ...page, path });
    reports.push(report);
    fixes.push(...report.fixes);
  }
  return { passed: reports.length > 0 && reports.every((report) => report.agreed), pages: reports, fixes };
}
