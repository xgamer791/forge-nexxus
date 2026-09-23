// The layout check, run as a chain of its own actions. A build parks its site
// here instead of saving it. The design worker renders every page at phone,
// tablet and desktop widths, measures it the way it measured the site's design
// reference, and compares the two region by region: the whole page, the
// header, the opened menu, the body and the footer (design-worker/layout.mjs,
// THRESHOLDS). No model judges anything here.
//
// A site that passes is saved exactly as it would have been without the check,
// pictures and all, in an action of its own. One that does not goes back to
// the builder with the measured differences -- reworked by agents, one for the
// shell and the home page and one for each other page that needs it, side by
// side, in slices (buildDraft.startRework) -- and the rework is checked again
// from the start. After three reworks, or when the check cannot run at all,
// nothing is saved and the credits go back.
//
// The check runs before the pictures are made: the worker stands in a box of
// the requested shape for every picture, and a mask never reads a picture's
// content, so the pictures are paid for once and only for a site that passed.
// Each step is its own action, so a build and several rounds of checking are
// never inside one ten-minute clock. The thread's and onboarding's watchdogs
// wait while a check, its rework agents or its save are beating, and speak
// for it once it has gone quiet.
import { v, type ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { releaseHold } from "./billing";
import { startRework } from "./buildDraft";
import { closeRun, providerTrace, type ProviderTrace } from "./diagnostics";
import { describe, finishThreadBuild } from "./generate";
import { finishOnboardingBuild, heartbeat, STEP_QUIET_MS, stopAttempt } from "./onboarding";
import { composePage, hasPages, normalizePath, type BuiltSite } from "./pages";
import { requestKind } from "./plans";
import { auditDesign, isMeasured, NOT_MEASURED, type AuditOutcome } from "./siteDesign";

// Reworks a build gets before it stops: round 1 is the first check, so the
// fourth check is the last.
const REWORKS = 3;
// Steps in a row that may come back with nothing to use -- a check that could
// not run, or a rework that could not be used -- before the build stops.
const MOST_TROUBLE = 2;
// A worker that could not answer gets a moment before it is asked again.
const RETRY_CHECK_MS = 15000;
const KEEP_GATES = 20;

// What the member reads while the check runs, in the thread and in the
// progress screen's log.
const CHECKING = "Checking the layout against the design reference…";
const REWORKING = "Reworking the layout to match the design reference…";
const CHECKING_EVENT = "Checking the layout against the design reference";
const SENT_BACK = "Layout sent back for changes";
const PASSED = "Layout passed the design check";
const COULD_NOT_CHECK = "The layout check couldn't run, so this build wasn't saved and your credits were returned. Try again.";
export const COULD_NOT_REWORK = "The builder couldn't rework the layout, so this build wasn't saved and your credits were returned. Try again.";
const OUT_OF_ROUNDS = "The layout still didn't match the design reference after three rounds of changes, so this build wasn't saved and your credits were returned. Try again.";

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const siteFields = {
  html: v.optional(v.string()),
  shell: v.optional(v.string()),
  pages: v.optional(v.array(pageValidator)),
};
const step = v.union(v.literal("checking"), v.literal("reworking"));

type Gate = Doc<"designGates">;

export function siteOfGate(gate: Pick<Gate, "html" | "shell" | "pages">): BuiltSite {
  return hasPages(gate) ? { shell: gate.shell, pages: gate.pages } : { html: gate.html };
}

// Every page as it would be served, for the worker to render.
function auditPages(site: BuiltSite) {
  if (!hasPages(site)) return [{ path: "/", html: site.html ?? "" }];
  return site.pages.map((page) => {
    const path = normalizePath(page.path) ?? page.path;
    return { path, html: composePage(site, path) ?? "" };
  });
}

// Whether the build is still waiting on this check: its credits still held,
// its reply still pending, its site not rebuilt or cancelled under it, and --
// for a first build -- its attempt still the one that is building.
export async function stillWaiting(ctx: MutationCtx, gate: Gate) {
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

// The check is over: the site it held goes, and the scores stay.
export async function endGate(ctx: MutationCtx, gate: Gate, status: "passed" | "failed" | "cancelled", error?: string) {
  await ctx.db.patch(gate._id, {
    status,
    ...(error ? { error } : {}),
    html: undefined,
    shell: undefined,
    pages: undefined,
    landLease: undefined,
    updatedAt: Date.now(),
  });
}

// Where the build has got to, in the member's words: the thread's pending
// reply for an edit, the progress log for a first build.
async function tell(ctx: MutationCtx, gate: Gate, now: "checking" | "reworking" | "passed") {
  if (gate.source === "thread") {
    if (now === "passed") return;
    const message = await ctx.db.get(gate.assistantId);
    if (message?.status === "pending") await ctx.db.patch(gate.assistantId, { body: now === "checking" ? CHECKING : REWORKING });
    return;
  }
  if (!gate.onboardingId) return;
  const row = await ctx.db.get(gate.onboardingId);
  if (!row || row.attempt !== gate.attempt || row.status !== "building") return;
  const at = Date.now();
  const label = now === "checking" ? CHECKING_EVENT : now === "reworking" ? SENT_BACK : PASSED;
  await ctx.db.patch(row._id, { updatedAt: at, events: [...row.events, { label, at }] });
}

async function prune(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("designGates").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").collect();
  const finished = rows.filter((row) => row.status === "failed" || row.status === "cancelled" || (row.status === "passed" && !row.shell && !row.html));
  for (const row of finished.slice(KEEP_GATES - 1)) {
    for (const agent of await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", row._id)).collect()) {
      await ctx.db.delete(agent._id);
    }
    await ctx.db.delete(row._id);
  }
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

// Parks a build's site for the check and starts the first round. A first
// build written by page agents (buildDraft.ts) comes here from inside the same
// transaction that finishes its last agent, so a site can never be handed on
// twice.
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
  await tell(ctx, (await ctx.db.get(gateId))!, "checking");
  await ctx.scheduler.runAfter(0, internal.designGate.check, { id: gateId });
  return gateId;
}

export const open = internalMutation({
  args: openArgs,
  returns: v.id("designGates"),
  handler: async (ctx, args) => await openGate(ctx, args),
});

// The start of a step. It hands the step its gate only while the build is
// still waiting on it, and marks it heard from, which is what the watchdogs
// read. A build that was cancelled or rebuilt under the check ends it here.
export const claim = internalMutation({
  args: { id: v.id("designGates"), step },
  handler: async (ctx, { id, step }): Promise<Gate | null> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== step) return null;
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(id, { updatedAt: now });
    if (gate.onboardingId) await ctx.db.patch(gate.onboardingId, { updatedAt: now });
    return { ...gate, updatedAt: now };
  },
});

// A sign of life from a step while it runs: the check waiting on the worker,
// or the save making its pictures. It is what the watchdogs read.
export const beat = internalMutation({
  args: { id: v.id("designGates"), status: v.union(v.literal("checking"), v.literal("passed")) },
  returns: v.boolean(),
  handler: async (ctx, { id, status }) => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== status) return false;
    const now = Date.now();
    await ctx.db.patch(id, { updatedAt: now });
    if (gate.onboardingId) {
      const row = await ctx.db.get(gate.onboardingId);
      if (row && row.attempt === gate.attempt && (row.status === "building" || row.status === "saving")) await ctx.db.patch(row._id, { updatedAt: now });
    }
    return true;
  },
});

// A round's scores, and what follows from them: on to the save, back to the
// builder's agents, or out of reworks.
export const judged = internalMutation({
  args: { id: v.id("designGates"), passed: v.boolean(), fixes: v.array(v.string()), lowest: v.number(), failing: v.array(v.string()) },
  handler: async (ctx, { id, passed, fixes, lowest, failing }): Promise<"passed" | "reworking" | "exhausted" | "gone"> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "checking") return "gone";
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return "gone";
    }
    const now = Date.now();
    const results = [...gate.results, { round: gate.round, passed, lowest, failing: failing.slice(0, 60), at: now }];
    if (passed) {
      await ctx.db.patch(id, { status: "passed", results, fixes: [], trouble: 0, updatedAt: now });
      await tell(ctx, gate, "passed");
      // The save is an action of its own, with a whole budget for the pictures.
      await ctx.scheduler.runAfter(0, internal.designGate.land, { id });
      return "passed";
    }
    if (gate.round > REWORKS) {
      await ctx.db.patch(id, { results, fixes, updatedAt: now });
      return "exhausted";
    }
    const next = { status: "reworking" as const, results, fixes, trouble: 0, problem: undefined, updatedAt: now };
    await ctx.db.patch(id, next);
    await tell(ctx, gate, "reworking");
    await startRework(ctx, { ...gate, ...next });
    return "reworking";
  },
});

// The rework, checked again from the start.
export async function reworkedWith(ctx: MutationCtx, gate: Gate, site: BuiltSite) {
  const fresh = await ctx.db.get(gate._id);
  if (!fresh || fresh.status !== "reworking") return false;
  await ctx.db.patch(gate._id, {
    html: site.html,
    shell: site.shell,
    pages: site.pages,
    round: fresh.round + 1,
    status: "checking",
    trouble: 0,
    problem: undefined,
    updatedAt: Date.now(),
  });
  await tell(ctx, fresh, "checking");
  await ctx.scheduler.runAfter(0, internal.designGate.check, { id: gate._id });
  return true;
}

// A rework finished by a one-reply rework from before the agents, which still
// lands here: it is checked again from the start.
export const reworked = internalMutation({
  args: { id: v.id("designGates"), ...siteFields },
  handler: async (ctx, { id, html, shell, pages }): Promise<boolean> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "reworking") return false;
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return false;
    }
    return await reworkedWith(ctx, gate, hasPages({ shell, pages }) ? { shell, pages } : { html });
  },
});

// A step that came back with nothing to use. It is tried again while the
// check has had fewer than a few of those in a row. A rework is tried again by
// a fresh round of agents, told what was wrong.
export const stumbled = internalMutation({
  args: { id: v.id("designGates"), step, problem: v.optional(v.string()) },
  handler: async (ctx, { id, step, problem }): Promise<"again" | "stop" | "gone"> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== step) return "gone";
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return "gone";
    }
    const trouble = gate.trouble + 1;
    if (trouble > MOST_TROUBLE) {
      await ctx.db.patch(id, { trouble, updatedAt: Date.now() });
      return "stop";
    }
    await ctx.db.patch(id, { trouble, problem, updatedAt: Date.now() });
    if (step === "checking") await ctx.scheduler.runAfter(RETRY_CHECK_MS, internal.designGate.check, { id });
    else await startRework(ctx, { ...gate, trouble, problem }, problem);
    return "again";
  },
});

// A build the check never let through. Nothing is saved and its credits go
// back. A first build says why on its progress screen, the way any failed
// build does; an edit says so in its reply, in the thread.
export async function failGate(ctx: MutationCtx, gate: Gate, reason: string) {
  if (gate.status === "failed" || gate.status === "cancelled") return;
  await endGate(ctx, gate, "failed", reason);
  for (const agent of await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", gate._id)).collect()) {
    if (agent.status === "writing" || agent.status === "waiting") {
      await ctx.db.patch(agent._id, { status: "cancelled", partial: undefined, thought: undefined, wrote: undefined, lease: undefined, updatedAt: Date.now() });
    }
  }
  if (gate.onboardingId && gate.attempt !== undefined) {
    await stopAttempt(ctx, { id: gate.onboardingId, attempt: gate.attempt, failed: true, reason });
    return;
  }
  const message = await ctx.db.get(gate.assistantId);
  if (message?.status === "pending") await ctx.db.patch(gate.assistantId, { body: reason, status: "failed" });
  await releaseHold(ctx, gate.holdId);
  await closeRun(ctx, { runId: gate.runId, status: "failed", error: reason });
}

export const fail = internalMutation({
  args: { id: v.id("designGates"), reason: v.string() },
  handler: async (ctx, { id, reason }): Promise<null> => {
    const gate = await ctx.db.get(id);
    if (gate) await failGate(ctx, gate, reason);
    return null;
  },
});

// The build has been saved: the site the check held can go.
export const settled = internalMutation({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.db.get(id);
    if (gate?.status === "passed") await endGate(ctx, gate, "passed");
    return null;
  },
});

async function stop(ctx: ActionCtx, id: Id<"designGates">, reason: string) {
  await ctx.runMutation(internal.designGate.fail, { id, reason });
}

// The site's measured reference, for the build it was measured for. Anything
// else -- none, an older kind, or one from before a rebuild -- is not one.
async function referenceFor(ctx: ActionCtx, gate: Gate) {
  const reference = await ctx.runQuery(internal.siteDesign.forSite, { siteId: gate.siteId });
  return reference && reference.buildEpoch === gate.epoch && isMeasured(reference) ? reference : null;
}

const percent = (score: number) => `${Math.round(score * 1000) / 10}%`;

// The check itself: the worker's scores for the site as it stands.
export const check = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.runMutation(internal.designGate.claim, { id, step: "checking" });
    if (!gate) return null;
    const stopBeating = heartbeat(() => ctx.runMutation(internal.designGate.beat, { id, status: "checking" }));
    try {
      const trace = providerTrace(ctx, gate.runId, gate.userId);
      const round = gate.round;
      const reference = await referenceFor(ctx, gate);
      if (!reference) {
        await stop(ctx, id, NOT_MEASURED);
        return null;
      }
      const site = siteOfGate(gate);
      await trace.note({
        phase: "layout_check",
        label: `Layout check, round ${round}: measuring every page at phone, tablet and desktop widths`,
        status: "reviewing",
        detail: { round },
      });
      let outcome: AuditOutcome;
      try {
        outcome = await auditDesign(ctx, { storageId: reference.storageId, pages: auditPages(site) }, trace, round);
      } catch (error) {
        await trace.note({ phase: "layout_check_error", label: `The layout check could not run: ${describe(error)}`, level: "warn", detail: { round } });
        const next = await ctx.runMutation(internal.designGate.stumbled, { id, step: "checking" });
        if (next === "stop") await stop(ctx, id, COULD_NOT_CHECK);
        return null;
      }
      await trace.note({
        phase: "layout_verdict",
        label: outcome.passed
          ? `Layout check, round ${round}: every page matches the design reference at every width`
          : `Layout check, round ${round}: ${outcome.failing.length} ${outcome.failing.length === 1 ? "region is" : "regions are"} below the bar, the lowest at ${percent(outcome.lowest)}`,
        level: outcome.passed ? "info" : "warn",
        detail: { round },
      });
      const next = await ctx.runMutation(internal.designGate.judged, {
        id,
        passed: outcome.passed,
        fixes: outcome.fixes,
        lowest: outcome.lowest,
        failing: outcome.failing,
      });
      if (next === "exhausted") await stop(ctx, id, OUT_OF_ROUNDS);
      return null;
    } finally {
      stopBeating();
    }
  },
});

// The start of the save. One copy saves a site that passed; another stops here.
export const claimLand = internalMutation({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<{ gate: Gate; lease: string } | null> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "passed" || (!gate.shell && !gate.html)) return null;
    const now = Date.now();
    if (gate.landLease && now - gate.updatedAt < STEP_QUIET_MS) return null;
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return null;
    }
    const lease = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    await ctx.db.patch(id, { landLease: lease, updatedAt: now });
    if (gate.onboardingId) await ctx.db.patch(gate.onboardingId, { updatedAt: now });
    return { gate: { ...gate, landLease: lease, updatedAt: now }, lease };
  },
});

// The save the build was going to make before the check held it: the
// pictures, then the version. It is an action of its own, so the check that
// passed the site and the pictures that finish it never share a clock.
export const land = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const claimed = await ctx.runMutation(internal.designGate.claimLand, { id });
    if (!claimed) return null;
    const { gate } = claimed;
    const stopBeating = heartbeat(() => ctx.runMutation(internal.designGate.beat, { id, status: "passed" }));
    try {
      const trace = providerTrace(ctx, gate.runId, gate.userId);
      await landSite(ctx, trace, gate, siteOfGate(gate));
    } catch (error) {
      await stop(ctx, id, describe(error));
      return null;
    } finally {
      stopBeating();
    }
    await ctx.runMutation(internal.designGate.settled, { id });
    return null;
  },
});

async function landSite(ctx: ActionCtx, trace: ProviderTrace, gate: Gate, site: BuiltSite) {
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

// What a rework agent is asked: its share of the measured differences, and the
// shape of its reply. The frame agent reworks the shell and the home page; a
// page agent reworks its page into a shell that is final; a site from before
// pages is one document, reworked whole.
export function reworkAgentRequest(input: {
  fixes: string[];
  part: "frame" | "page" | "document";
  path?: string;
  missing?: boolean;
  problem?: string;
}) {
  const listed = input.fixes.map((fix) => (/^\s/.test(fix) ? fix : `- ${fix}`)).join("\n");
  const what = input.part === "page" ? `the page ${input.path}` : input.part === "frame" ? "the shell and the home page" : "your site";
  const opening = input.part === "page" && input.missing
    ? `Forge's layout check found that your site has no page at ${input.path}, which the measured design reference in your instructions has. Build it, following its measured layout.`
    : `Forge's layout check rendered every page of your site at phone, tablet and desktop widths and measured it against the measured design reference in your instructions. ${capitalized(what)} ${input.part === "document" ? "does" : "do"} not match it yet. Make every one of these changes:`;
  const reply = input.part === "frame"
    ? "Reply with one sentence saying what you changed, then the whole shell in a ```html shell block, then the home page in a ```html path=\"/\" block if you changed it, and nothing after. Write the shell out in full: the head, every style the pages use, every script and the <!--forge-page--> marker. Agents reworking the other pages build on the shell you return, so keep every class and style they use."
    : input.part === "page"
      ? `The shell is final and cannot change, so any styles this page needs that the shell does not have go in one <style> element at the start of the page's markup, every rule scoped to classes only this page uses. Reply with one sentence saying what you changed, then the whole page in a \`\`\`html path="${input.path}" block, and nothing after. Write it all out.`
      : "Reply with one sentence saying what you changed, then the whole page in a ```html block, and nothing after. Write it all out.";
  return [
    opening,
    ...(listed ? [listed] : []),
    ...(input.problem ? [`Your last rework could not be used: ${input.problem}`] : []),
    input.part === "page"
      ? "Change the layout only: the page's sections, their order, heights, columns and spacing. Keep your words and pictures original."
      : "Change the layout only: the header, the menu, the sections, their order, heights, columns and spacing, and the footer. Keep your words and pictures original, and keep one page for every route the reference lists and no others.",
    reply,
  ].join("\n\n");
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// A rework round a one-reply rework from before the agents left queued: the
// round is handed to agents instead.
export const rework = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    await ctx.runMutation(internal.designGate.beginRework, { id });
    return null;
  },
});

export const beginRework = internalMutation({
  args: { id: v.id("designGates") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "reworking") return null;
    if (!(await stillWaiting(ctx, gate))) {
      await endGate(ctx, gate, "cancelled");
      return null;
    }
    const agents = await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", id).eq("round", gate.round)).collect();
    if (agents.some((agent) => agent.status === "writing" || agent.status === "waiting")) return null;
    await startRework(ctx, gate, gate.problem);
    return null;
  },
});

// What the check found on recent builds, for whoever runs the deployment:
// `npx convex run designGate:inspect`. Each round's lowest score and the
// regions below the bar. Never a page.
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
