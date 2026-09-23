// The auditor gate, run as a chain of its own actions. A build parks its site
// here instead of saving it. The design worker checks each page against the
// SkillUI Ultra extract: one header auditor, two body auditors and one footer
// auditor. A page is saved only when they agree. There is no clone score.
//
// A site that passes is saved exactly as it would have been without the check,
// pictures and all. One that does not goes back to the builder with the
// measured differences, and the rework is checked again from the start. After
// three reworks, or when the check cannot run at all, nothing is saved and the
// credits go back.
//
// The check runs before the pictures are made: the worker stands in a box of
// the requested shape for every picture, and a mask never reads a picture's
// content, so the pictures are paid for once and only for a site that passed.
// Each step is its own action, so a build and several rounds of checking are
// never inside one ten-minute clock. The thread's and onboarding's watchdogs
// wait while a check is moving and speak for it once it has gone quiet.
import { v, type ObjectType } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { releaseHold } from "./billing";
import { elided, lostPageStyles } from "./designCheck";
import { closeRun, providerTrace, type ProviderTrace } from "./diagnostics";
import { builtSite, callProvider, describe, designAgentTurn, finishThreadBuild, parseReply, parseShellReply } from "./generate";
import { finishOnboardingBuild, stopAttempt } from "./onboarding";
import { BODY_MARKER, composePage, hasPages, normalizePath, type BuiltSite } from "./pages";
import { requestKind } from "./plans";
import { assertDesignRules, auditDesign, isMeasured, NOT_MEASURED, type AuditOutcome } from "./siteDesign";

// Reworks a build gets before it stops: round 1 is the first check, so the
// fourth check is the last.
const REWORKS = 3;
// Steps in a row that may come back with nothing to use -- a check that could
// not run, or a rework that could not be used -- before the build stops.
const MOST_TROUBLE = 2;
// A worker that could not answer gets a moment before it is asked again.
const RETRY_CHECK_MS = 15000;
const KEEP_GATES = 20;
// The measured differences a rework is given, at most.
const FIXES_CHARS = 40000;

// What the member reads while the check runs, in the thread and in the
// progress screen's log.
const CHECKING = "Checking the layout against the design reference…";
const REWORKING = "Reworking the layout to match the design reference…";
const CHECKING_EVENT = "Checking the layout against the design reference";
const SENT_BACK = "Layout sent back for changes";
const PASSED = "Layout passed the design check";
const COULD_NOT_CHECK = "The layout check couldn't run, so this build wasn't saved and your credits were returned. Try again.";
const COULD_NOT_REWORK = "The builder couldn't rework the layout, so this build wasn't saved and your credits were returned. Try again.";
const OUT_OF_ROUNDS = "The layout still didn't match the design reference after three rounds of changes, so this build wasn't saved and your credits were returned. Try again.";

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const siteFields = {
  html: v.optional(v.string()),
  shell: v.optional(v.string()),
  pages: v.optional(v.array(pageValidator)),
};
const step = v.union(v.literal("checking"), v.literal("reworking"));

type Gate = Doc<"designGates">;

function siteOf(gate: Gate): BuiltSite {
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

// The check is over: the site it held goes, and the scores stay.
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

// Parks a build's site for the check and starts the first round. A build
// written a page at a time (buildDraft.ts) comes here from inside the same
// transaction that closes its draft, so a site can never be handed on twice.
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
      await end(ctx, gate, "cancelled");
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(id, { updatedAt: now });
    if (gate.onboardingId) await ctx.db.patch(gate.onboardingId, { updatedAt: now });
    return { ...gate, updatedAt: now };
  },
});

// A round's scores, and what follows from them: through to the save, back to
// the builder, or out of reworks.
export const judged = internalMutation({
  args: { id: v.id("designGates"), passed: v.boolean(), fixes: v.array(v.string()), lowest: v.number(), failing: v.array(v.string()) },
  handler: async (ctx, { id, passed, fixes, lowest, failing }): Promise<"passed" | "reworking" | "exhausted" | "gone"> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "checking") return "gone";
    if (!(await stillWaiting(ctx, gate))) {
      await end(ctx, gate, "cancelled");
      return "gone";
    }
    const now = Date.now();
    const results = [...gate.results, { round: gate.round, passed, lowest, failing: failing.slice(0, 60), at: now }];
    if (passed) {
      await ctx.db.patch(id, { status: "passed", results, fixes: [], trouble: 0, updatedAt: now });
      await tell(ctx, gate, "passed");
      return "passed";
    }
    if (gate.round > REWORKS) {
      await ctx.db.patch(id, { results, fixes, updatedAt: now });
      return "exhausted";
    }
    await ctx.db.patch(id, { status: "reworking", results, fixes, trouble: 0, problem: undefined, updatedAt: now });
    await tell(ctx, gate, "reworking");
    await ctx.scheduler.runAfter(0, internal.designGate.rework, { id });
    return "reworking";
  },
});

// The builder's rework, which is checked again from the start.
export const reworked = internalMutation({
  args: { id: v.id("designGates"), ...siteFields },
  handler: async (ctx, { id, html, shell, pages }): Promise<boolean> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== "reworking") return false;
    if (!(await stillWaiting(ctx, gate))) {
      await end(ctx, gate, "cancelled");
      return false;
    }
    await ctx.db.patch(id, {
      html,
      shell,
      pages,
      round: gate.round + 1,
      status: "checking",
      trouble: 0,
      problem: undefined,
      updatedAt: Date.now(),
    });
    await tell(ctx, gate, "checking");
    await ctx.scheduler.runAfter(0, internal.designGate.check, { id });
    return true;
  },
});

// A step that came back with nothing to use. It is tried again while the
// check has had fewer than a few of those in a row.
export const stumbled = internalMutation({
  args: { id: v.id("designGates"), step, problem: v.optional(v.string()) },
  handler: async (ctx, { id, step, problem }): Promise<"again" | "stop" | "gone"> => {
    const gate = await ctx.db.get(id);
    if (!gate || gate.status !== step) return "gone";
    if (!(await stillWaiting(ctx, gate))) {
      await end(ctx, gate, "cancelled");
      return "gone";
    }
    const trouble = gate.trouble + 1;
    if (trouble > MOST_TROUBLE) {
      await ctx.db.patch(id, { trouble, updatedAt: Date.now() });
      return "stop";
    }
    await ctx.db.patch(id, { trouble, problem, updatedAt: Date.now() });
    if (step === "checking") await ctx.scheduler.runAfter(RETRY_CHECK_MS, internal.designGate.check, { id });
    else await ctx.scheduler.runAfter(0, internal.designGate.rework, { id });
    return "again";
  },
});

// A build the check never let through. Nothing is saved and its credits go
// back. A first build says why on its progress screen, the way any failed
// build does; an edit says so in its reply, in the thread.
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

// The build has been saved: the site the check held can go.
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

// The site's measured reference, for the build it was measured for. Anything
// else -- none, an older kind, or one from before a rebuild -- is not one.
async function referenceFor(ctx: ActionCtx, gate: Gate) {
  const reference = await ctx.runQuery(internal.siteDesign.forSite, { siteId: gate.siteId });
  return reference && reference.buildEpoch === gate.epoch && isMeasured(reference) ? reference : null;
}

// The check itself: the auditors' agreement for the site as it stands.
export const check = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.runMutation(internal.designGate.claim, { id, step: "checking" });
    if (!gate) return null;
    const trace = providerTrace(ctx, gate.runId, gate.userId);
    const round = gate.round;
    const reference = await referenceFor(ctx, gate);
    if (!reference) {
      await stop(ctx, id, NOT_MEASURED);
      return null;
    }
    const site = siteOf(gate);
    await trace.note({
      phase: "layout_check",
      label: `Design auditors, round ${round}: checking each page against the SkillUI Ultra extract`,
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
        ? `Design auditors, round ${round}: every auditor agreed`
        : `Design auditors, round ${round}: ${outcome.failing.length} ${outcome.failing.length === 1 ? "check did" : "checks did"} not agree`,
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
    if (next === "exhausted") {
      await stop(ctx, id, OUT_OF_ROUNDS);
      return null;
    }
    if (next !== "passed") return null;
    try {
      await land(ctx, trace, gate, site);
    } catch (error) {
      await stop(ctx, id, describe(error));
      return null;
    }
    await ctx.runMutation(internal.designGate.settled, { id });
    return null;
  },
});

// The save the build was going to make before the check held it: the
// pictures, then the version.
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

// What the builder is asked on a rework: the measured differences, and the
// shape of the reply.
function reworkRequest(input: { fixes: string[]; inPages: boolean; problem?: string }) {
  const listed: string[] = [];
  let size = 0;
  for (const fix of input.fixes) {
    if (size + fix.length > FIXES_CHARS) break;
    listed.push(`- ${fix}`);
    size += fix.length;
  }
  const reply = input.inPages
    ? "Reply with one sentence saying what you changed, then the whole shell in a ```html shell block, then each page you changed in its own ```html path=\"/about\" title=\"About\" block, and nothing after. Every page you do not return stays exactly as it is. Write the shell out in full: the head, every style the pages use, every script and the <!--forge-page--> marker."
    : "Reply with one sentence saying what you changed, then the whole page in a ```html block, and nothing after. Write it all out.";
  return [
    "The design auditors compared this site with the SkillUI Ultra extract, one page at a time. They do not agree yet. Make every one of these changes:",
    listed.join("\n"),
    ...(input.problem ? [`Your last rework could not be used: ${input.problem}`] : []),
    "Change the layout only: the header, the menu, the sections, their order, heights, columns and spacing, and the footer. Keep your words and pictures original, and keep one page for every route the reference lists and no others.",
    reply,
  ].join("\n\n");
}

// Why a rework cannot be used, in words the builder can put right.
class Unusable extends Error {}

// The builder's rework, read against the site it reworked. A site in pages
// keeps every page the reply did not send back; its new shell has to be whole,
// written out in full, and still style everything the pages use.
function reworkOf(reply: string, before: BuiltSite): BuiltSite {
  if (hasPages(before)) {
    let back: ReturnType<typeof parseShellReply>;
    try {
      back = parseShellReply(reply);
    } catch {
      throw new Unusable("the shell was missing, or stopped before </html>. Send back the whole shell, closed with its fence.");
    }
    if (before.shell.includes(BODY_MARKER) && !back.shell.includes(BODY_MARKER)) {
      throw new Unusable(`the shell lost its ${BODY_MARKER} marker, so no page had anywhere to go.`);
    }
    const gap = elided(back.shell);
    if (gap) {
      throw new Unusable(`the shell has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`);
    }
    const pages = before.pages.map((page) => back.pages.find((next) => next.path === page.path) ?? page);
    for (const page of back.pages) if (!pages.some((kept) => kept.path === page.path)) pages.push(page);
    const lost = lostPageStyles(before.shell, back.shell, pages);
    if (lost.length) {
      throw new Unusable(`the shell dropped the styles the pages use for ${lost.slice(0, 12).map((name) => `.${name}`).join(", ")}. Keep every one of them.`);
    }
    return { shell: back.shell, pages };
  }
  let parsed: ReturnType<typeof parseReply>;
  try {
    parsed = parseReply(reply);
  } catch {
    throw new Unusable("the page stopped before </html>. Send back the whole page, closed with its fence.");
  }
  const site = builtSite(parsed);
  if (!site) throw new Unusable("the reply had no page in it. Send back the whole page.");
  const gap = elided(site.html ?? site.shell ?? "");
  if (gap) {
    throw new Unusable(`the page has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`);
  }
  return site;
}

// The builder, given its work back with the measured differences and the
// measured reference it was built from.
export const rework = internalAction({
  args: { id: v.id("designGates") },
  handler: async (ctx, { id }): Promise<null> => {
    const gate = await ctx.runMutation(internal.designGate.claim, { id, step: "reworking" });
    if (!gate) return null;
    const trace = providerTrace(ctx, gate.runId, gate.userId);
    const reference = await referenceFor(ctx, gate);
    if (!reference) {
      await stop(ctx, id, NOT_MEASURED);
      return null;
    }
    const before = siteOf(gate);
    await trace.note({
      phase: "layout_rework",
      label: `Sent back to the builder after round ${gate.round} of the layout check`,
      status: "calling",
      detail: { round: gate.round },
    });
    try {
      const messages = designAgentTurn(gate.siteName, before, undefined,
        reworkRequest({ fixes: gate.fixes, inPages: hasPages(before), problem: gate.problem }), reference.prompt);
      const reply = await callProvider(messages, undefined, undefined, trace, "build");
      const back = reworkOf(reply, before);
      try {
        assertDesignRules(back, reference.referenceUrl);
      } catch (error) {
        throw new Unusable(describe(error));
      }
      await trace.note({
        phase: "layout_rework_done",
        label: "The builder sent back its rework",
        detail: { round: gate.round, htmlChars: (back.shell ?? back.html ?? "").length },
      });
      await ctx.runMutation(internal.designGate.reworked, { id, ...back });
    } catch (error) {
      const problem = error instanceof Unusable ? error.message : undefined;
      await trace.note({
        phase: "layout_rework_error",
        label: `The rework could not be used: ${problem ?? describe(error)}`,
        level: "warn",
        detail: { round: gate.round },
      });
      const next = await ctx.runMutation(internal.designGate.stumbled, { id, step: "reworking", problem });
      if (next === "stop") await stop(ctx, id, COULD_NOT_REWORK);
    }
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
