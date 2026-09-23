import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { ProviderTrace } from "./diagnostics";
import { composePage, hasPages, siteParts, type BuiltSite } from "./pages";

const CITIES = ["Los Angeles", "New York", "San Diego", "Miami"];

// Phases the measured worker actually emits. Research is /research; the layout
// check is /audit. Thresholds live in the worker (design-worker/layout.mjs,
// 0.85 on every region). A check that does not pass is not a save.
const PHASES: Record<string, string> = {
  searching: "Searching for design references",
  candidate: "Comparing reference sites",
  inspecting: "Measuring reference pages",
  measuring: "Reading the measured layout",
  uploading: "Saving the measured design reference",
  rendering: "Measuring the built site",
  comparing: "Comparing the layout with the reference",
};

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

export const save = internalMutation({
  args: {
    siteId: v.id("sites"), onboardingId: v.id("siteOnboarding"), attempt: v.number(), epoch: v.number(),
    storageId: v.id("_storage"), referenceUrl: v.string(), prompt: v.string(), inspectedPages: v.number(),
  },
  handler: async (ctx, args) => {
    const site = await ctx.db.get(args.siteId);
    const brief = await ctx.db.get(args.onboardingId);
    const uploaded = await ctx.db.system.get(args.storageId);
    if (!site || !brief || !uploaded || brief.siteId !== site._id || brief.userId !== site.userId ||
        brief.attempt !== args.attempt || !["queued", "building"].includes(brief.status) ||
        (site.buildEpoch ?? 0) !== args.epoch) return false;
    if (!/^https:\/\//.test(args.referenceUrl) || !args.prompt.trim() || args.prompt.length > 80000 ||
        args.inspectedPages < 1) return false;
    await discardSiteDesign(ctx, site._id);
    await ctx.db.insert("siteDesignPackages", {
      userId: site.userId, siteId: site._id, storageId: args.storageId,
      referenceUrl: args.referenceUrl, prompt: args.prompt, inspectedPages: args.inspectedPages,
      buildEpoch: args.epoch, createdAt: Date.now(),
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

type WorkerLine = {
  type?: string;
  phase?: string;
  detail?: { city?: unknown; page?: unknown; total?: unknown; pages?: unknown; done?: unknown; routes?: unknown; domain?: unknown };
  reason?: unknown;
  storageId?: unknown;
  referenceUrl?: unknown;
  prompt?: unknown;
  inspectedPages?: unknown;
  passed?: unknown;
  fixes?: unknown;
};

function workerTarget(path: "/research" | "/audit") {
  const base = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  const token = process.env.DESIGN_WORKER_TOKEN;
  if (!base || !token || !base.startsWith("https://")) {
    throw new Error("Design research is not configured. Set the design worker URL and token before building.");
  }
  return { url: `${base}${path}`, token };
}

function progressLabel(phase: string, detail: WorkerLine["detail"]) {
  const city = typeof detail?.city === "string" && CITIES.includes(detail.city) ? detail.city : "";
  const page = Number.isInteger(detail?.page) && (detail?.page as number) > 0 ? detail?.page as number : 0;
  const total = Number.isInteger(detail?.total) && (detail?.total as number) > 0 ? detail?.total as number : 0;
  const done = Number.isInteger(detail?.done) && (detail?.done as number) > 0 ? detail?.done as number : 0;
  const pages = Number.isInteger(detail?.pages) && (detail?.pages as number) > 0 ? detail?.pages as number : 0;
  const routes = Number.isInteger(detail?.routes) && (detail?.routes as number) > 0 ? detail?.routes as number : 0;
  const domain = typeof detail?.domain === "string" ? detail.domain.slice(0, 80) : "";
  const counted = phase === "rendering" && done ? done : page;
  const countedTotal = phase === "rendering" && done ? total : total;
  const label = phase === "searching" && city ? `Searching ${city} for design references`
    : phase === "candidate" && domain ? `Comparing ${domain}`
    : phase === "inspecting" && page && total ? `Measuring reference page ${page} of ${total}`
    : phase === "measuring" && pages ? `Measured ${pages} reference page${pages === 1 ? "" : "s"}`
    : phase === "uploading" && pages ? `Saving ${pages} measured page${pages === 1 ? "" : "s"}`
    : phase === "rendering" && done && total ? `Measuring the built site, ${done} of ${total}`
    : phase === "comparing" && routes ? `Comparing ${routes} route${routes === 1 ? "" : "s"} with the reference`
    : PHASES[phase];
  return {
    label,
    detail: {
      ...(city ? { city } : {}),
      ...(counted && countedTotal ? { page: counted, total: countedTotal } : {}),
    },
  };
}

async function readWorker(response: Response, limit: number, onLine: (event: WorkerLine) => Promise<void>) {
  if (!response.ok || !response.body) throw new Error(`Design worker answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    if (pending.length > limit) throw new Error("Design worker sent an oversized event");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      await onLine(JSON.parse(line) as WorkerLine);
    }
    if (done) break;
  }
}

// The pages the layout check measures: each route as the document a visitor
// would be served, shell and page together. A legacy one-document site is home.
export function pagesForAudit(site: BuiltSite): { path: string; html: string }[] {
  if (hasPages(site)) {
    return site.pages.map((page) => {
      const html = composePage({ shell: site.shell, pages: site.pages }, page.path);
      if (!html) throw new Error(`Page ${page.path} could not be composed for the layout check`);
      return { path: page.path, html };
    });
  }
  if (site.html) return [{ path: "/", html: site.html }];
  return [];
}

// The worker streams events as work happens. Only a completed measured
// reference is accepted; a missing worker or a failed crawl stops the build,
// never silently sends a model off to invent a reference.
export async function researchDesign(
  ctx: ActionCtx,
  input: { siteId: Id<"sites">; onboardingId: Id<"siteOnboarding">; attempt: number; epoch: number;
    offer: string; audience: string; feel: string; references: string },
  trace: ProviderTrace,
) {
  const worker = workerTarget("/research");
  const uploadUrl = await ctx.runMutation(internal.siteDesign.uploadUrl, { siteId: input.siteId, epoch: input.epoch });
  const response = await fetch(worker.url, {
    method: "POST",
    headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...input, uploadUrl }),
    signal: AbortSignal.timeout(360000),
  });
  await trace.note({ phase: "research", label: "Researching design references", status: "researching" });
  // Assigned inside the stream callback. A local `let` narrowed after that
  // callback is `never`, because the assignment is not visible to control flow.
  const found: { result: { storageId: Id<"_storage">; referenceUrl: string; prompt: string; inspectedPages: number } | null } = { result: null };
  await readWorker(response, 200000, async (event) => {
    if (event.type === "progress" && typeof event.phase === "string" && typeof PHASES[event.phase] === "string") {
      const noted = progressLabel(event.phase, event.detail);
      await trace.note({ phase: `research_${event.phase}`, label: noted.label, status: "researching", detail: noted.detail });
    } else if (event.type === "complete" && typeof event.storageId === "string" &&
        typeof event.referenceUrl === "string" && typeof event.prompt === "string" &&
        Number.isInteger(event.inspectedPages)) {
      // The worker's line also carries `type`. Copy the package fields into a
      // new object so that extra key never reaches the save mutation.
      found.result = {
        storageId: event.storageId as Id<"_storage">,
        referenceUrl: event.referenceUrl,
        prompt: event.prompt,
        inspectedPages: event.inspectedPages as number,
      };
    } else if (event.type === "error") {
      throw new Error(`Design research failed: ${String(event.reason).slice(0, 180)}`);
    }
  });
  const result = found.result;
  if (!result || !result.storageId || !result.referenceUrl || !result.prompt || !result.inspectedPages) {
    throw new Error("The measured design reference was not returned");
  }
  const saved = await ctx.runMutation(internal.siteDesign.save, {
    siteId: input.siteId,
    onboardingId: input.onboardingId,
    attempt: input.attempt,
    epoch: input.epoch,
    storageId: result.storageId,
    referenceUrl: result.referenceUrl,
    prompt: result.prompt,
    inspectedPages: result.inspectedPages,
  });
  if (!saved) {
    await ctx.runMutation(internal.siteDesign.discardUpload, { storageId: result.storageId });
    throw new Error("The site changed before its design reference could be saved");
  }
  await trace.note({ phase: "research_done", label: "Measured design reference saved", status: "researching" });
  return result.prompt;
}

// Fail closed. The worker measures the built pages against the saved reference
// and applies THRESHOLDS in design-worker/layout.mjs (0.85 on every region).
// A missing worker, a dropped stream, or passed: false stops the save.
export async function auditDesign(ctx: ActionCtx, storageId: Id<"_storage">, site: BuiltSite, trace: ProviderTrace) {
  const worker = workerTarget("/audit");
  const reference = await ctx.storage.getUrl(storageId);
  if (!reference || !reference.startsWith("https://")) {
    throw new Error("The measured design reference could not be read for the layout check");
  }
  const pages = pagesForAudit(site);
  if (!pages.length) throw new Error("The layout check had no pages to measure");
  await trace.note({ phase: "audit", label: "Checking the layout against the measured reference" });
  const response = await fetch(worker.url, {
    method: "POST",
    headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
    body: JSON.stringify({ reference, pages }),
    signal: AbortSignal.timeout(360000),
  });
  let passed: boolean | null = null;
  let fixes: string[] = [];
  await readWorker(response, 8 * 1024 * 1024, async (event) => {
    if (event.type === "progress" && typeof event.phase === "string" && typeof PHASES[event.phase] === "string") {
      const noted = progressLabel(event.phase, event.detail);
      await trace.note({ phase: `audit_${event.phase}`, label: noted.label, detail: noted.detail });
    } else if (event.type === "complete") {
      passed = event.passed === true;
      fixes = Array.isArray(event.fixes) ? event.fixes.filter((line): line is string => typeof line === "string").slice(0, 8) : [];
    } else if (event.type === "error") {
      throw new Error(`Layout check failed: ${String(event.reason).slice(0, 180)}`);
    }
  });
  if (passed !== true) {
    const why = fixes.length ? ` ${fixes.join(" ")}` : "";
    throw new Error(`The layout check did not pass. The site was not saved.${why}`.slice(0, 500));
  }
  await trace.note({ phase: "audit_done", label: "Layout check passed" });
}
