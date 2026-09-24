import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { siteParts, type BuiltSite } from "./pages";

// What every build is held to on its way to being saved, whoever wrote it:
// DESIGN_GOD's Type rule, that fonts come from Fontshare and nowhere else.
export function assertDesignRules(site: BuiltSite) {
  const html = siteParts(site).join("\n");
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(html)) {
    throw new Error("The page used a font outside Fontshare. Follow Design God's Type rules.");
  }
}

// Retired: the design packages the design worker once researched for each
// site. Nothing reads or writes them any more; a site's go when it is rebuilt
// or deleted.
export async function discardSiteDesign(ctx: MutationCtx, siteId: Id<"sites">) {
  const rows = await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", siteId)).collect();
  for (const row of rows) {
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  }
}

// How long a step of the design audit can go without a word before it is
// taken for dead. A step is one action, and an action has ten minutes.
export const GATE_QUIET_MS = 630000;

// Whether a check is still carrying its build, for the thread's watchdog.
export function gateInFlight(gate: { status: string; updatedAt: number } | null | undefined, now = Date.now()) {
  return Boolean(gate && ["checking", "reworking", "passed"].includes(gate.status) && now - gate.updatedAt < GATE_QUIET_MS);
}
