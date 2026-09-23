import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { ProviderTrace } from "./diagnostics";
import { siteParts, type BuiltSite } from "./pages";

const PHASES: Record<string, string> = {
  searching: "Searching for design references",
  candidate: "Comparing reference sites",
  inspecting: "Inspecting pages and menus",
  skillui: "SkillUI ultra is capturing the design",
  uploading: "Saving the design package",
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

// The worker streams events as work happens. Only its completed ultra package
// is accepted; a missing worker or a failed crawl stops the build, never
// silently sends a model off to invent a reference.
export async function researchDesign(
  ctx: ActionCtx,
  input: { siteId: Id<"sites">; onboardingId: Id<"siteOnboarding">; attempt: number; epoch: number;
    offer: string; audience: string; feel: string; references: string },
  trace: ProviderTrace,
) {
  const base = process.env.DESIGN_WORKER_URL?.replace(/\/+$/, "");
  const token = process.env.DESIGN_WORKER_TOKEN;
  if (!base || !token || !base.startsWith("https://")) {
    throw new Error("Design research is not configured. Set the design worker URL and token before building.");
  }
  const uploadUrl = await ctx.runMutation(internal.siteDesign.uploadUrl, { siteId: input.siteId, epoch: input.epoch });
  const response = await fetch(`${base}/research`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...input, uploadUrl }),
    signal: AbortSignal.timeout(360000),
  });
  if (!response.ok || !response.body) throw new Error(`Design research worker answered ${response.status}`);
  await trace.note({ phase: "research", label: "Researching design references", status: "researching" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result: { storageId: Id<"_storage">; referenceUrl: string; prompt: string; inspectedPages: number } | null = null;
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    if (pending.length > 200000) throw new Error("Design research sent an oversized event");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "progress" && typeof PHASES[event.phase] === "string") {
        const city = typeof event.detail?.city === "string" &&
          ["Los Angeles", "New York", "San Diego", "Miami"].includes(event.detail.city) ? event.detail.city : "";
        const page = Number.isInteger(event.detail?.page) && event.detail.page > 0 ? event.detail.page : 0;
        const total = Number.isInteger(event.detail?.total) && event.detail.total > 0 ? event.detail.total : 0;
        const label = event.phase === "searching" && city ? `Searching ${city} for design references`
          : event.phase === "inspecting" && page && total ? `Inspecting reference page ${page} of ${total}`
          : PHASES[event.phase];
        await trace.note({ phase: `research_${event.phase}`, label, status: "researching",
          detail: { ...(city ? { city } : {}), ...(page ? { page, total } : {}),
            ...(event.phase === "skillui" ? { mode: "ultra", screens: 12 } : {}) } });
      } else if (event.type === "complete") {
        result = event;
      } else if (event.type === "error") {
        throw new Error(`Design research failed: ${String(event.reason).slice(0, 180)}`);
      }
    }
    if (done) break;
  }
  if (!result || !result.storageId || !result.referenceUrl || !result.prompt || !result.inspectedPages) {
    throw new Error("SkillUI did not return a complete design package");
  }
  const saved = await ctx.runMutation(internal.siteDesign.save, {
    ...result, siteId: input.siteId, onboardingId: input.onboardingId,
    attempt: input.attempt, epoch: input.epoch,
  });
  if (!saved) {
    await ctx.runMutation(internal.siteDesign.discardUpload, { storageId: result.storageId });
    throw new Error("The site changed before its design package could be saved");
  }
  await trace.note({ phase: "research_done", label: "SkillUI ultra design package saved", status: "researching" });
  return result.prompt;
}
