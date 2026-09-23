import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { ProviderTrace } from "./diagnostics";
import { MAX_PAGES, normalizePath, pagePlan, siteParts, type BuiltSite } from "./pages";

// A SkillUI Ultra design package: the `.skill` archive SkillUI extracted from
// the reference site, screen by screen, for the pages the design worker's page
// discovery agent chose (design-worker/). A row without this format -- none,
// or the retired measured reference -- is from before SkillUI Ultra.
export const SKILLUI = "skillui-ultra-v1" as const;
export function isSkillUI(row: Pick<Doc<"siteDesignPackages">, "format"> | null | undefined) {
  return row?.format === SKILLUI;
}

// What a build or an edit says when the site has no SkillUI Ultra reference
// for its current build: a site from before it, or one never researched.
export const NOT_EXTRACTED = "This site needs a new design reference before it can change. Rebuild the site to make one, then try again.";

// The worker's stages, in the words of the member's progress log.
const PHASES: Record<string, string> = {
  searching: "Searching for design references",
  candidate: "Comparing reference sites",
  discovering: "Choosing up to five pages from the reference",
  skillui: "Reading the reference's design with SkillUI Ultra",
  uploading: "Saving the design reference",
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

// The extract is the package's SKILL, DESIGN, layout, component and
// interaction references, cut to fit; a document still has to stay under
// Convex's megabyte.
const PROMPT_LIMIT = 400000;
const FOUNDATION_LIMIT = 60000;

export const save = internalMutation({
  args: {
    siteId: v.id("sites"), onboardingId: v.id("siteOnboarding"), attempt: v.number(), epoch: v.number(),
    storageId: v.id("_storage"), referenceUrl: v.string(), prompt: v.string(), inspectedPages: v.number(),
    routes: v.array(v.string()),
    // The package's tokens as custom properties, for every page's <head>.
    foundation: v.optional(v.string()),
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
        (args.foundation?.length ?? 0) > FOUNDATION_LIMIT || args.inspectedPages < 1 ||
        !args.routes.some((route) => normalizePath(route) === "/")) return false;
    await discardSiteDesign(ctx, site._id);
    await ctx.db.insert("siteDesignPackages", {
      userId: site.userId, siteId: site._id, storageId: args.storageId,
      referenceUrl: args.referenceUrl, prompt: args.prompt, inspectedPages: args.inspectedPages,
      buildEpoch: args.epoch, createdAt: Date.now(), format: SKILLUI,
      // Five pages at most, the home page first, whatever the worker sent.
      routes: pagePlan(args.routes),
      ...(args.foundation?.trim() ? { foundation: args.foundation.trim() } : {}),
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

// The worker streams events as work happens. Only a complete SkillUI Ultra
// package is accepted; a missing worker, a failed crawl or a SkillUI run that
// produced nothing stops the build, and never silently sends a model off to
// invent a reference. A site that already has a reference address is
// extracted again there, with no search.
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
    label: input.referenceUrl ? "Reading the saved reference's design again" : "Researching design references",
    status: "researching",
  });
  let result = null as { storageId: Id<"_storage">; referenceUrl: string; prompt: string; inspectedPages: number; routes: string[]; foundation?: string } | null;
  await readLines(response, async (event) => {
    if (event.type === "progress" && typeof PHASES[event.phase] === "string") {
      const city = typeof event.detail?.city === "string" &&
        ["Los Angeles", "New York", "San Diego", "Miami"].includes(event.detail.city) ? event.detail.city : "";
      const page = Number.isInteger(event.detail?.page) && event.detail.page > 0 ? event.detail.page : 0;
      const total = Number.isInteger(event.detail?.total) && event.detail.total > 0 ? event.detail.total : 0;
      const pages = Number.isInteger(event.detail?.pages) && event.detail.pages > 0 ? Math.min(event.detail.pages, MAX_PAGES) : 0;
      const screens = Number.isInteger(event.detail?.screens) && event.detail.screens > 0 ? Math.min(event.detail.screens, MAX_PAGES) : 0;
      const label = event.phase === "searching" && city ? `Searching ${city} for design references`
        : event.phase === "discovering" && pages ? `Chose ${pages === 1 ? "1 page" : `${pages} pages`} from the reference`
        : event.phase === "skillui" && screens ? `Reading the reference's design with SkillUI Ultra, ${screens === 1 ? "1 screen" : `${screens} screens`}`
        : PHASES[event.phase];
      await trace.note({ phase: `research_${event.phase}`, label, status: "researching",
        detail: { ...(city ? { city } : {}), ...(page ? { page, total } : {}), ...(pages ? { total: pages } : {}),
          ...(screens ? { mode: "ultra", screens } : {}) } });
    } else if (event.type === "complete" && typeof event.storageId === "string" &&
        typeof event.referenceUrl === "string" && typeof event.prompt === "string" &&
        Number.isInteger(event.inspectedPages) && Array.isArray(event.routes) &&
        event.routes.every((route: unknown) => typeof route === "string") &&
        (event.foundation === undefined || typeof event.foundation === "string")) {
      // Only the package's own fields go on to the save.
      result = {
        storageId: event.storageId as Id<"_storage">,
        referenceUrl: event.referenceUrl,
        prompt: event.prompt,
        inspectedPages: event.inspectedPages,
        routes: event.routes,
        ...(event.foundation ? { foundation: event.foundation } : {}),
      };
    } else if (event.type === "error") {
      throw new Error(`Design research failed: ${String(event.reason).slice(0, 180)}`);
    }
  });
  const found = result;
  if (!found || !found.storageId || !found.referenceUrl || !found.prompt || !found.inspectedPages || !found.routes.length) {
    throw new Error("The design worker didn't return a complete SkillUI Ultra package");
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
    ...(found.foundation ? { foundation: found.foundation } : {}),
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

// How long a step of the design audit can go without a word before it is
// taken for dead. A step is one action, and an action has ten minutes.
export const GATE_QUIET_MS = 630000;

// Whether a check is still carrying its build, for the thread's watchdog.
export function gateInFlight(gate: { status: string; updatedAt: number } | null | undefined, now = Date.now()) {
  return Boolean(gate && ["checking", "reworking", "passed"].includes(gate.status) && now - gate.updatedAt < GATE_QUIET_MS);
}
