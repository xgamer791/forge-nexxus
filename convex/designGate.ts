// The landing, run as an action of its own. A build parks its site here
// instead of saving it -- a first build or a rebuild once every page is
// written (buildDraft.ts), an edit made in the thread once its reply is read
// (generate.ts) -- and a step of its own makes the site's pictures and saves
// it, on a clock of its own rather than whatever the build left of one. The
// thread's and onboarding's watchdogs wait while a landing is moving and
// speak for it once it has gone quiet.
//
// This was where the design auditors held a site until they agreed it matched
// its SkillUI Ultra reference. They are gone: a site lands as it was written.
// Rows from their time keep their rounds and verdicts (`inspect`).
import { v, type ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { releaseHold } from "./billing";
import { closeRun, providerTrace, type ProviderTrace } from "./diagnostics";
import { describe, finishThreadBuild } from "./generate";
import { finishOnboardingBuild, stopAttempt } from "./onboarding";
import { hasPages, type BuiltSite } from "./pages";
import { requestKind } from "./plans";
import { isSkillUI, NOT_EXTRACTED } from "./siteDesign";

const KEEP_GATES = 20;

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const siteFields = {
  html: v.optional(v.string()),
  shell: v.optional(v.string()),
  pages: v.optional(v.array(pageValidator)),
};

type Gate = Doc<"designGates">;

function siteOf(gate: Gate): BuiltSite {
  return hasPages(gate) ? { shell: gate.shell, pages: gate.pages } : { html: gate.html };
}

// Whether the build is still waiting on its landing: its credits still held,
// its reply still pending, its site not rebuilt or cancelled under it, and --
// for a first build -- its attempt still the one that is building.
async function stillWaiting(ctx: MutationCtx, gate: Gate) {
  const hold = await ctx.db.get(gate.holdId);
  if (hold?.status !== "held") return false;
  const site = await ctx.db.get(gate.siteId);
  if (!site || (site.buildEpoch ?? 0) !== gate.epoch) return false;
  const message = await ctx.db.get(gate.assistantId);
  if (message?.status !== "pending") return false;
  if (gate.onboardingId) {
    const row = await ctx.db.get(gate.onboardingId);
    if (!row || row.attempt !== gate.attempt || row.status !== "building") return false;
  }
  return true;
}

// The landing is over: the site it held goes.
async function end(ctx: MutationCtx, gate: Gate, status: "passed" | "failed" | "cancelled", error?: string) {
  await ctx.db.patch(gate._id, {
    status,
    ...(error ? { error } : {}),
    html: undefined,
    shell: undefined,
    pages: undefined,
    updatedAt: Date.now(),
  });
}

async function prune(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("designGates").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").collect();
  const finished = rows.filter((row) => row.status === "failed" || row.status === "cancelled" || (row.status === "passed" && !row.shell && !row.html));
  for (const row of finished.slice(KEEP_GATES - 1)) await ctx.db.delete(row._id);
}

const openArgs = {
  source: v.union(v.literal("thread"), v.literal("onboarding")),
  userId: v.id("users"),
  siteId: v.id("sites"),
  runId: v.id("buildRuns"),
  assistantId: v.id("messages"),
  holdId: v.id("creditHolds"),
  requestKind,
  epoch: v.number(),
  onboardingId: v.optional(v.id("siteOnboarding")),
  attempt: v.optional(v.number()),
  rebuild: v.optional(v.boolean()),
  siteName: v.string(),
  prompt: v.optional(v.string()),
  remember: v.optional(v.boolean()),
  blockedNote: v.optional(v.string()),
  ...siteFields,
  summary: v.string(),
};

// Parks a build's site and queues its landing. A build written a page at a
// time (buildDraft.ts) comes here from inside the same transaction that closes
// its draft, so a site can never be handed on twice.
export async function openGate(ctx: MutationCtx, args: ObjectType<typeof openArgs>) {
  await prune(ctx, args.userId);
  const now = Date.now();
  const gateId = await ctx.db.insert("designGates", {
    ...args,
    status: "checking",
    round: 1,
    trouble: 0,
    fixes: [],
    results: [],
    createdAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.designGate.check, { id: gateId });
  return gateId;
}

export const open = internalMutation({
  args: openArgs,
  returns: v.id("designGates"),
  handler: async (ctx, args) => await openGate(ctx, args),
});

// The start of the landing. It hands the step its gate only while the build
// is still waiting on it, and marks it heard from, which is what the
// watchdogs read. A build that was cancelled or rebuilt under it ends here.
export const claim = internalMutation({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<Gate | null> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "checking") return null;
    if (!(await stillWaiting(ctx, gate))) {
      await end(ctx, gate, "cancelled");
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(id, { updatedAt: now });
    if (gate.onboardingId) await ctx.db.patch(gate.onboardingId, { updatedAt: now });
    return { ...gate, updatedAt: now };
  },
});

// On its way to the save: the landing has the site now, and the watchdogs
// wait on it while it is heard from.
export const passed = internalMutation({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<boolean> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "checking") return false;
    if (!(await stillWaiting(ctx, gate))) {
      await end(ctx, gate, "cancelled");
      return false;
    }
    await ctx.db.patch(id, { status: "passed", updatedAt: Date.now() });
    return true;
  },
});

// A build that could not land. Nothing is saved and its credits go back. A
// first build says why on its progress screen, the way any failed build does;
// an edit says so in its reply, in the thread.
export const fail = internalMutation({
  args: { id: v.id("designGates"), reason: v.string() },
  handler: async (ctx, { id, reason }): Promise<null> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status === "failed" || gate.status === "cancelled") return null;
    await end(ctx, gate, "failed", reason);
    if (gate.onboardingId && gate.attempt !== undefined) {
      await stopAttempt(ctx, { id: gate.onboardingId, attempt: gate.attempt, failed: true, reason });
      return null;
    }
    const message = await ctx.db.get(gate.assistantId);
    if (message?.status === "pending") await ctx.db.patch(gate.assistantId, { body: reason, status: "failed" });
    await releaseHold(ctx, gate.holdId);
    await closeRun(ctx, { runId: gate.runId, status: "failed", error: reason });
    return null;
  },
});

// The build has been saved: the site the landing held can go.
export const settled = internalMutation({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.db.get(id);
    if (gate?.status === "passed") await end(ctx, gate, "passed");
    return null;
  },
});

async function stop(ctx: ActionCtx, id: Id<"designGates">, reason: string) {
  await ctx.runMutation(internal.designGate.fail, { id, reason });
}

// The site's SkillUI Ultra reference, for the build it was extracted for.
// Anything else -- none, an older kind, or one from before a rebuild -- is not
// one.
async function referenceFor(ctx: ActionCtx, gate: Gate) {
  const reference = await ctx.runQuery(internal.siteDesign.forSite, { siteId: gate.siteId });
  return reference && reference.buildEpoch === gate.epoch && isSkillUI(reference) ? reference : null;
}

// The landing itself: the pictures, then the version. A site whose SkillUI
// Ultra reference is no longer the one it was built from does not land.
export const check = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.runMutation(internal.designGate.claim, { id });
    if (!gate) return null;
    const trace = providerTrace(ctx, gate.runId, gate.userId);
    if (!(await referenceFor(ctx, gate))) {
      await stop(ctx, id, NOT_EXTRACTED);
      return null;
    }
    if (!(await ctx.runMutation(internal.designGate.passed, { id }))) return null;
    try {
      await land(ctx, trace, gate, siteOf(gate));
    } catch (error) {
      await stop(ctx, id, describe(error));
      return null;
    }
    await ctx.runMutation(internal.designGate.settled, { id });
    return null;
  },
});

// The save the build was going to make: the pictures, then the version.
async function land(ctx: ActionCtx, trace: ProviderTrace, gate: Gate, site: BuiltSite) {
  if (gate.source === "onboarding" && gate.onboardingId && gate.attempt !== undefined) {
    await finishOnboardingBuild(ctx, trace, {
      id: gate.onboardingId,
      attempt: gate.attempt,
      runId: gate.runId,
      userId: gate.userId,
      result: { siteId: gate.siteId, holdId: gate.holdId, assistantId: gate.assistantId, requestKind: gate.requestKind, epoch: gate.epoch },
      rebuild: gate.rebuild ?? false,
      site,
      summary: gate.summary,
    });
    return;
  }
  await finishThreadBuild(ctx, trace, {
    runId: gate.runId,
    userId: gate.userId,
    siteId: gate.siteId,
    assistantId: gate.assistantId,
    holdId: gate.holdId,
    requestKind: gate.requestKind,
    epoch: gate.epoch,
    siteName: gate.siteName,
    prompt: gate.prompt ?? "",
    remember: gate.remember ?? false,
    blockedNote: gate.blockedNote,
    site,
    summary: gate.summary,
  });
}

// Recent landings, for whoever runs the deployment:
// `npx convex run designGate:inspect`. Rows from before the design auditors
// were removed also carry each audit round's verdict and the parts sent back.
// Never a page.
export const inspect = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("designGates").order("desc").take(KEEP_GATES);
    return rows.map((row) => ({
      id: row._id,
      source: row.source,
      siteName: row.siteName,
      status: row.status,
      round: row.round,
      results: row.results,
      error: row.error ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});
