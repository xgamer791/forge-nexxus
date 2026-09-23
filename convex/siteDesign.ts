import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { ProviderTrace } from "./diagnostics";
import { normalizePath, siteParts, type BuiltSite } from "./pages";

// A measured design reference: every route of the reference site at phone,
// tablet and desktop widths, as the design worker measured it (see
// design-worker/). A row without this format is from before measuring.
export const MEASURED = "forge-measured-v1" as const;
export function isMeasured(row: Pick<Doc<"siteDesignPackages">, "format"> | null | undefined) {
  return row?.format === MEASURED;
}

// What a build or an edit says when the site has no measured reference for
// its current build: a site from before measuring, or one never researched.
export const NOT_MEASURED = "This site's design reference hasn't been measured yet. Rebuild the site to measure it, then try again.";

const PHASES: Record<string, string> = {
  searching: "Searching for design references",
  candidate: "Comparing reference sites",
  inspecting: "Inspecting pages and menus",
  measuring: "Measuring the reference site's layout",
  uploading: "Saving the design reference",
};

// The measured spec for the pages a turn writes: everything before the first
// route -- what the reference decides, its routes, its type scale -- and then
// those routes' own sections. A later turn writes one page, and the numbers
// for pages it is not writing are only more to read before it starts. A spec
// in another shape, or one without the route, goes whole.
export function routeSpec(spec: string, paths: string[]) {
  const lines = spec.split("\n");
  const starts = lines.flatMap((line, index) => (/^ROUTE \S/.test(line) ? [index] : []));
  if (!starts.length) return spec;
  const kept = lines.slice(0, starts[0]);
  let found = false;
  starts.forEach((start, n) => {
    const path = normalizePath(lines[start].slice("ROUTE ".length).trim());
    if (path === null || !paths.includes(path)) return;
    found = true;
    kept.push(...lines.slice(start, starts[n + 1] ?? lines.length));
  });
  return found ? kept.join("\n").trimEnd() : spec;
}

export function assertDesignRules(site: BuiltSite, referenceUrl: string) {
  const html = siteParts(site).join("\n");
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(html)) {
    throw new Error("The page used a font outside Fontshare. Follow Design God's Type rules.");
  }
  const host = new URL(referenceUrl).hostname.replace(/^www\./, "");
  const urls = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)"']+/gi) ?? [];
  if (urls.some(text => {
    const matched = text.match(/https?:\/\/[^\s"')]+/i);
    if (!matched) return false;
    try { return new URL(matched[0]).hostname.replace(/^www\./, "") === host; } catch { return false; }
  })) throw new Error("The page linked an asset or page from its design reference. Use original content and images.");
}

export const forSite = internalQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) =>
    await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", siteId)).first(),
});

export const siteEpoch = internalQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    const site = await ctx.db.get(siteId);
    return site?.buildEpoch ?? 0;
  },
});

export const uploadUrl = internalMutation({
  args: { siteId: v.id("sites"), epoch: v.number() },
  handler: async (ctx, { siteId, epoch }) => {
    const site = await ctx.db.get(siteId);
    if (!site || (site.buildEpoch ?? 0) !== epoch) throw new Error("The site changed while researching");
    return await ctx.storage.generateUploadUrl();
  },
});

// The spec is written from every route at every width, so it grows with the
// reference; a document still has to stay under Convex's megabyte.
const PROMPT_LIMIT = 400000;

export const save = internalMutation({
  args: {
    siteId: v.id("sites"), onboardingId: v.id("siteOnboarding"), attempt: v.number(), epoch: v.number(),
    storageId: v.id("_storage"), referenceUrl: v.string(), prompt: v.string(), inspectedPages: v.number(),
    routes: v.array(v.string()),
    // The research's hold on its attempt (onboarding.claimStep). A copy that
    // lost it saves nothing.
    lease: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const site = await ctx.db.get(args.siteId);
    const brief = await ctx.db.get(args.onboardingId);
    const uploaded = await ctx.db.system.get(args.storageId);
    if (!site || !brief || !uploaded || brief.siteId !== site._id || brief.userId !== site.userId ||
        brief.attempt !== args.attempt || !["queued", "building"].includes(brief.status) ||
        (site.buildEpoch ?? 0) !== args.epoch) return false;
    if (args.lease !== undefined && brief.queueStep?.lease !== args.lease) return false;
    if (!/^https:\/\//.test(args.referenceUrl) || !args.prompt.trim() || args.prompt.length > PROMPT_LIMIT ||
        args.inspectedPages < 1 || !args.routes.includes("/")) return false;
    await discardSiteDesign(ctx, site._id);
    await ctx.db.insert("siteDesignPackages", {
      userId: site.userId, siteId: site._id, storageId: args.storageId,
      referenceUrl: args.referenceUrl, prompt: args.prompt, inspectedPages: args.inspectedPages,
      buildEpoch: args.epoch, createdAt: Date.now(), format: MEASURED, routes: args.routes,
    });
    return true;
  },
});

export const discardUpload = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
  },
});

export async function discardSiteDesign(ctx: MutationCtx, siteId: Id<"sites">) {
  const rows = await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", siteId)).collect();
  for (const row of rows) {
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  }
}

function workerRoute() {
  const base = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  const token = process.env.DESIGN_WORKER_TOKEN;
  if (!base || !token || !base.startsWith("https://")) {
    throw new Error("Design research is not configured. Set the design worker URL and token before building.");
  }
  return { base, token };
}

// The worker streams one JSON object a line as the work happens, and ends with
// a `complete` or an `error` line. Anything else, or nothing, is a failure.
async function readLines(response: Response, onLine: (event: any) => Promise<void>) {
  if (!response.body) throw new Error("The design worker sent nothing back");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    if (pending.length > 4000000) throw new Error("The design worker sent an oversized event");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) await onLine(JSON.parse(line));
    }
    if (done) break;
  }
}

// The worker streams events as work happens. Only a complete measured
// reference is accepted; a missing worker or a failed crawl stops the build,
// never silently sends a model off to invent a reference. A site that already
// has a reference address is measured there again, with no search.
export async function researchDesign(
  ctx: ActionCtx,
  input: { siteId: Id<"sites">; onboardingId: Id<"siteOnboarding">; attempt: number; epoch: number;
    offer: string; audience: string; feel: string; references: string; referenceUrl?: string },
  trace: ProviderTrace,
  lease?: string,
) {
  const { base, token } = workerRoute();
  const uploadUrl = await ctx.runMutation(internal.siteDesign.uploadUrl, { siteId: input.siteId, epoch: input.epoch });
  const response = await fetch(`${base}/research`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...input, uploadUrl }),
    signal: AbortSignal.timeout(420000),
  });
  if (!response.ok) throw new Error(`Design research worker answered ${response.status}`);
  await trace.note({
    phase: "research",
    label: input.referenceUrl ? "Measuring the saved design reference again" : "Researching design references",
    status: "researching",
  });
  let result = null as { storageId: Id<"_storage">; referenceUrl: string; prompt: string; inspectedPages: number; routes: string[] } | null;
  await readLines(response, async (event) => {
    if (event.type === "progress" && typeof PHASES[event.phase] === "string") {
      const city = typeof event.detail?.city === "string" &&
        ["Los Angeles", "New York", "San Diego", "Miami"].includes(event.detail.city) ? event.detail.city : "";
      const page = Number.isInteger(event.detail?.page) && event.detail.page > 0 ? event.detail.page : 0;
      const total = Number.isInteger(event.detail?.total) && event.detail.total > 0 ? event.detail.total : 0;
      const label = event.phase === "searching" && city ? `Searching ${city} for design references`
        : event.phase === "inspecting" && page && total ? `Inspecting reference page ${page} of ${total}`
        : PHASES[event.phase];
      await trace.note({ phase: `research_${event.phase}`, label, status: "researching",
        detail: { ...(city ? { city } : {}), ...(page ? { page, total } : {}) } });
    } else if (event.type === "complete" && typeof event.storageId === "string" &&
        typeof event.referenceUrl === "string" && typeof event.prompt === "string" &&
        Number.isInteger(event.inspectedPages) && Array.isArray(event.routes) &&
        event.routes.every((route: unknown) => typeof route === "string")) {
      // Only the reference's own fields go on to the save.
      result = {
        storageId: event.storageId as Id<"_storage">,
        referenceUrl: event.referenceUrl,
        prompt: event.prompt,
        inspectedPages: event.inspectedPages,
        routes: event.routes,
      };
    } else if (event.type === "error") {
      throw new Error(`Design research failed: ${String(event.reason).slice(0, 180)}`);
    }
  });
  const found = result;
  if (!found || !found.storageId || !found.referenceUrl || !found.prompt || !found.inspectedPages || !found.routes.length) {
    throw new Error("The design worker didn't return a complete design reference");
  }
  const saved = await ctx.runMutation(internal.siteDesign.save, {
    siteId: input.siteId,
    onboardingId: input.onboardingId,
    attempt: input.attempt,
    epoch: input.epoch,
    storageId: found.storageId,
    referenceUrl: found.referenceUrl,
    prompt: found.prompt,
    inspectedPages: found.inspectedPages,
    routes: found.routes,
    ...(lease ? { lease } : {}),
  });
  if (!saved) {
    await ctx.runMutation(internal.siteDesign.discardUpload, { storageId: found.storageId });
    throw new Error("The site changed before its design reference could be saved");
  }
  await trace.note({ phase: "research_done", label: "Design reference saved", status: "researching",
    detail: { total: found.inspectedPages } });
  return found.prompt;
}

export type AuditOutcome = {
  passed: boolean;
  fixes: string[];
  // The lowest region score over every route and width, and the regions that
  // fell short, as `route width region score`.
  lowest: number;
  failing: string[];
};

// The layout check, run by the design worker: each page of the site, served as
// it would be, measured at every width and compared with the measured
// reference, region by region. A worker that cannot say is a failure here,
// never a pass.
export async function auditDesign(
  ctx: ActionCtx,
  input: { storageId: Id<"_storage">; pages: { path: string; html: string }[] },
  trace: ProviderTrace,
  round: number,
): Promise<AuditOutcome> {
  const { base, token } = workerRoute();
  const reference = await ctx.storage.getUrl(input.storageId);
  if (!reference) throw new Error("The measured design reference is missing from storage");
  const response = await fetch(`${base}/audit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ reference, pages: input.pages }),
    signal: AbortSignal.timeout(480000),
  });
  if (!response.ok) throw new Error(`The layout check answered ${response.status}`);
  let outcome = null as AuditOutcome | null;
  await readLines(response, async (event) => {
    if (event.type === "progress" && event.phase === "rendering" && Number.isInteger(event.detail?.total)) {
      const done = Number(event.detail.done) || 0;
      if (done === event.detail.total || done % 3 === 0) {
        await trace.note({ phase: "layout_check_progress", label: `Layout check, round ${round}: measured ${done} of ${event.detail.total} pages and widths`, status: "reviewing", detail: { round, page: done, total: event.detail.total } });
      }
    } else if (event.type === "complete" && typeof event.passed === "boolean" && Array.isArray(event.routes)) {
      const failing: string[] = [];
      let lowest = 1;
      for (const route of event.routes) {
        if (route.problem) {
          failing.push(`${route.path} ${route.problem}`);
          lowest = 0;
          continue;
        }
        for (const [width, result] of Object.entries(route.viewports ?? {}) as [string, any][]) {
          if (!result?.regions) {
            failing.push(`${route.path} ${width} not measured`);
            lowest = 0;
            continue;
          }
          for (const [region, score] of Object.entries(result.regions) as [string, any][]) {
            lowest = Math.min(lowest, Number(score.score) || 0);
            if (!score.passed) failing.push(`${route.path} ${width} ${region} ${Math.round((Number(score.score) || 0) * 1000) / 10}`);
          }
        }
      }
      outcome = {
        // No route, or no score for one, is not a pass.
        passed: event.passed === true && event.routes.length > 0 && failing.length === 0,
        fixes: Array.isArray(event.fixes) ? event.fixes.filter((fix: unknown) => typeof fix === "string").slice(0, 400) : [],
        lowest,
        failing: failing.slice(0, 200),
      };
    } else if (event.type === "error") {
      throw new Error(`The layout check failed: ${String(event.reason).slice(0, 180)}`);
    }
  });
  if (!outcome) throw new Error("The layout check returned no result");
  return outcome;
}

// How long a step of the layout check can go without a word before it is
// taken for dead. A step is one action, and an action has ten minutes.
export const GATE_QUIET_MS = 630000;

// Whether a check is still carrying its build, for the thread's watchdog.
export function gateInFlight(gate: { status: string; updatedAt: number } | null | undefined, now = Date.now()) {
  return Boolean(gate && ["checking", "reworking", "passed"].includes(gate.status) && now - gate.updatedAt < GATE_QUIET_MS);
}
