// The per-page crew, and the fail-closed reading of an auditor report.
// Header: 1 builder + 1 auditor. Body: 2 builders + 2 auditors.
// Footer: 1 builder + 1 auditor. A page with any other shape, or any auditor
// who does not agree, is not complete.

export const MAX_PAGES = 5;

export const CREW = {
  header: { builders: 1, auditors: 1 },
  body: { builders: 2, auditors: 2 },
  footer: { builders: 1, auditors: 1 },
} as const;

export const PAGE_CREW =
  "Each page is built by a fixed crew and is not complete until every auditor agrees it matches the SkillUI Ultra extract. " +
  "Header: 1 build agent and 1 auditor. Body: 2 build agents and 2 auditors. Footer: 1 build agent and 1 auditor. " +
  "Write the header, the body and the footer. Do not invent a design system; use the SkillUI Ultra extract in your instructions.";

type RegionName = keyof typeof CREW;
type AuditorReport = { agree?: boolean };
type RegionReport = { builders?: number; auditors?: AuditorReport[] };
type PageReport = { path?: string; crew?: Partial<Record<RegionName, RegionReport>> };

const REGIONS: RegionName[] = ["header", "body", "footer"];

export function capRoutes(routes: readonly string[]): string[] {
  return routes.slice(0, MAX_PAGES);
}

// `passed: true` from the worker is not enough. The crew has to be the one
// above, on every page, and every auditor has to agree.
export function crewAgreed(report: { passed?: boolean; pages?: PageReport[]; fixes?: unknown } | null | undefined) {
  const failing: string[] = [];
  const pages = Array.isArray(report?.pages) ? report.pages : [];
  if (!pages.length) failing.push("no page");
  if (pages.length > MAX_PAGES) failing.push(`more than ${MAX_PAGES} pages`);
  for (const page of pages) {
    const path = typeof page?.path === "string" && page.path ? page.path : "?";
    for (const region of REGIONS) {
      const slot = page?.crew?.[region];
      const need = CREW[region];
      const auditors = Array.isArray(slot?.auditors) ? slot.auditors : [];
      if (slot?.builders !== need.builders || auditors.length !== need.auditors) {
        failing.push(`${path} ${region} crew`);
        continue;
      }
      auditors.forEach((auditor, index) => {
        if (auditor?.agree !== true) failing.push(`${path} ${region} auditor ${index + 1}`);
      });
    }
  }
  const fixes = Array.isArray(report?.fixes)
    ? report.fixes.filter((fix): fix is string => typeof fix === "string").slice(0, 400)
    : [];
  const passed = report?.passed === true && failing.length === 0 && pages.length > 0 && pages.length <= MAX_PAGES;
  if (!passed && !fixes.length) fixes.push("The auditors did not agree the page matches the SkillUI Ultra extract.");
  return { passed, failing: failing.slice(0, 200), fixes, lowest: passed ? 1 : 0 };
}
