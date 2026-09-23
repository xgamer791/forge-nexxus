// The design check, run as a chain of its own actions. A build whose header,
// dropdown menu and footer are new parks its site here instead of saving it.
// Forge's design reviewer -- a second, separate agent with its own
// instructions, which never sees the design agent's -- compares those three
// parts with the Awwwards originals the design agent named. When it agrees,
// the build is saved exactly as it would have been without the check. When it
// does not, the design agent gets the work back with the reviewer's fixes, and
// the reworked site is checked again from the start. A build the reviewer
// never agrees to is not saved, and its credits go back.
//
// Each step is its own action, so a build and several rounds of checking are
// never inside one ten-minute clock. The thread's and onboarding's watchdogs
// wait while a check is moving and speak for it once it has gone quiet.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { releaseHold } from "./billing";
import {
  elided,
  lostPageStyles,
  partList,
  PARTS,
  readVerdict,
  reviewMessages,
  revisionsAllowed,
  reworkRequest,
  unnamedParts,
  unnamedVerdict,
  type Verdict,
} from "./designCheck";
import { closeRun, providerTrace, type ProviderTrace } from "./diagnostics";
import { builtSite, callProvider, describe, designAgentTurn, finishThreadBuild, parseReply, parseShellReply } from "./generate";
import { finishOnboardingBuild, stopAttempt } from "./onboarding";
import { BODY_MARKER, hasPages, type BuiltSite } from "./pages";
import { requestKind } from "./plans";

// A verdict is a short answer, so the reviewer gets less of the clock than a
// build does, and the pictures and the save still fit behind it when it agrees.
const REVIEW_BUDGET_MS = 360000;
// Steps in a row that may come back with nothing to use -- no verdict, or a
// rework that could not be used -- before the build stops.
const MOST_TROUBLE = 2;
const KEEP_REVIEWS = 20;

// What the member reads while the check runs, in the thread and in the
// progress screen's log.
const CHECKING = "Checking the header, menu and footer…";
const REWORKING = "Reworking the header, menu and footer…";
const SENT_BACK = "Header, menu and footer sent back for changes";
const PASSED = "Header, menu and footer passed the design check";

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const siteFields = {
  html: v.optional(v.string()),
  shell: v.optional(v.string()),
  pages: v.optional(v.array(pageValidator)),
};
const verdictValidator = v.object({
  equal: v.boolean(),
  header: v.boolean(),
  menu: v.boolean(),
  footer: v.boolean(),
  originals: v.array(v.string()),
  fixes: v.array(v.string()),
});

type Review = Doc<"designReviews">;

function siteOf(review: Review): BuiltSite {
  return hasPages(review) ? { shell: review.shell, pages: review.pages } : { html: review.html };
}

// Whether the build is still waiting on this check: its credits still held,
// its reply still pending, its site not rebuilt or cancelled under it, and --
// for a first build -- its attempt still the one that is building.
async function stillWaiting(ctx: MutationCtx, review: Review) {
  const hold = await ctx.db.get(review.holdId);
  if (hold?.status !== "held") return false;
  const site = await ctx.db.get(review.siteId);
  if (!site || (site.buildEpoch ?? 0) !== review.epoch) return false;
  const message = await ctx.db.get(review.assistantId);
  if (message?.status !== "pending") return false;
  if (review.onboardingId) {
    const row = await ctx.db.get(review.onboardingId);
    if (!row || row.attempt !== review.attempt || row.status !== "building") return false;
  }
  return true;
}

// The check is over: the site it held goes, and the verdicts stay.
async function end(ctx: MutationCtx, review: Review, status: "passed" | "failed" | "cancelled", error?: string) {
  await ctx.db.patch(review._id, {
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
async function tell(ctx: MutationCtx, review: Review, step: "checking" | "revising" | "passed") {
  if (review.source === "thread") {
    if (step === "passed") return;
    const message = await ctx.db.get(review.assistantId);
    if (message?.status === "pending") await ctx.db.patch(review.assistantId, { body: step === "checking" ? CHECKING : REWORKING });
    return;
  }
  if (step === "checking" || !review.onboardingId) return;
  const row = await ctx.db.get(review.onboardingId);
  if (!row || row.attempt !== review.attempt || row.status !== "building") return;
  const at = Date.now();
  await ctx.db.patch(row._id, { updatedAt: at, events: [...row.events, { label: step === "passed" ? PASSED : SENT_BACK, at }] });
}

async function prune(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("designReviews").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").collect();
  const finished = rows.filter((row) => row.status === "passed" || row.status === "failed" || row.status === "cancelled");
  for (const row of finished.slice(KEEP_REVIEWS - 1)) await ctx.db.delete(row._id);
}

export const open = internalMutation({
  args: {
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
    clones: v.optional(v.string()),
  },
  returns: v.id("designReviews"),
  handler: async (ctx, args) => {
    await prune(ctx, args.userId);
    const now = Date.now();
    const reviewId = await ctx.db.insert("designReviews", {
      ...args,
      status: "checking",
      round: 1,
      trouble: 0,
      fixes: [],
      verdicts: [],
      createdAt: now,
      updatedAt: now,
    });
    await tell(ctx, (await ctx.db.get(reviewId))!, "checking");
    await ctx.scheduler.runAfter(0, internal.designReview.check, { id: reviewId });
    return reviewId;
  },
});

// The start of a step. It hands the step its review only while the build is
// still waiting on it, and marks it heard from, which is what the watchdogs
// read. A build that was cancelled or rebuilt under the check ends it here.
export const claim = internalMutation({
  args: { id: v.id("designReviews"), step: v.union(v.literal("checking"), v.literal("revising")) },
  handler: async (ctx, { id, step }): Promise<Review | null> => {
    const review = await ctx.db.get(id);
    if (!review || review.status !== step) return null;
    if (!(await stillWaiting(ctx, review))) {
      await end(ctx, review, "cancelled");
      return null;
    }
    await ctx.db.patch(id, { updatedAt: Date.now() });
    return { ...review, updatedAt: Date.now() };
  },
});

// A verdict, and what follows from it: through to the save, back to the
// design agent, or out of rounds.
export const judged = internalMutation({
  args: { id: v.id("designReviews"), verdict: verdictValidator },
  handler: async (ctx, { id, verdict }): Promise<"passed" | "revising" | "exhausted" | "gone"> => {
    const review = await ctx.db.get(id);
    if (!review || review.status !== "checking") return "gone";
    if (!(await stillWaiting(ctx, review))) {
      await end(ctx, review, "cancelled");
      return "gone";
    }
    const now = Date.now();
    const verdicts = [...review.verdicts, { round: review.round, ...verdict, at: now }];
    if (verdict.equal) {
      await ctx.db.patch(id, { status: "passed", verdicts, fixes: [], trouble: 0, updatedAt: now });
      await tell(ctx, review, "passed");
      return "passed";
    }
    if (review.round > revisionsAllowed()) {
      await ctx.db.patch(id, { verdicts, fixes: verdict.fixes, updatedAt: now });
      return "exhausted";
    }
    await ctx.db.patch(id, { status: "revising", verdicts, fixes: verdict.fixes, trouble: 0, problem: undefined, updatedAt: now });
    await tell(ctx, review, "revising");
    await ctx.scheduler.runAfter(0, internal.designReview.revise, { id });
    return "revising";
  },
});

// The design agent's rework, which the reviewer checks again from the start.
export const reworked = internalMutation({
  args: { id: v.id("designReviews"), ...siteFields, clones: v.optional(v.string()) },
  handler: async (ctx, { id, html, shell, pages, clones }): Promise<boolean> => {
    const review = await ctx.db.get(id);
    if (!review || review.status !== "revising") return false;
    if (!(await stillWaiting(ctx, review))) {
      await end(ctx, review, "cancelled");
      return false;
    }
    await ctx.db.patch(id, {
      html,
      shell,
      pages,
      clones: clones?.trim() || review.clones,
      round: review.round + 1,
      status: "checking",
      trouble: 0,
      problem: undefined,
      updatedAt: Date.now(),
    });
    await tell(ctx, review, "checking");
    await ctx.scheduler.runAfter(0, internal.designReview.check, { id });
    return true;
  },
});

// A step that came back with nothing to use. It is tried again while the
// check has had fewer than a few of those in a row.
export const stumbled = internalMutation({
  args: { id: v.id("designReviews"), step: v.union(v.literal("checking"), v.literal("revising")), problem: v.optional(v.string()) },
  handler: async (ctx, { id, step, problem }): Promise<"again" | "stop" | "gone"> => {
    const review = await ctx.db.get(id);
    if (!review || review.status !== step) return "gone";
    if (!(await stillWaiting(ctx, review))) {
      await end(ctx, review, "cancelled");
      return "gone";
    }
    const trouble = review.trouble + 1;
    if (trouble > MOST_TROUBLE) {
      await ctx.db.patch(id, { trouble, updatedAt: Date.now() });
      return "stop";
    }
    await ctx.db.patch(id, { trouble, problem, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, step === "checking" ? internal.designReview.check : internal.designReview.revise, { id });
    return "again";
  },
});

// A build the check never let through. Nothing is saved and its credits go
// back. A first build says why on its progress screen, the way any failed
// build does. An edit's turn already answered the member when it handed the
// site over, so its pending reply becomes the explanation, in the thread.
export const fail = internalMutation({
  args: { id: v.id("designReviews"), reason: v.string() },
  handler: async (ctx, { id, reason }): Promise<null> => {
    const review = await ctx.db.get(id);
    if (!review || review.status === "failed" || review.status === "cancelled") return null;
    await end(ctx, review, "failed", reason);
    if (review.onboardingId && review.attempt !== undefined) {
      await stopAttempt(ctx, { id: review.onboardingId, attempt: review.attempt, failed: true, reason });
      return null;
    }
    const message = await ctx.db.get(review.assistantId);
    if (message?.status === "pending") await ctx.db.patch(review.assistantId, { body: reason, status: undefined });
    await releaseHold(ctx, review.holdId);
    await closeRun(ctx, { runId: review.runId, status: "failed", error: reason });
    return null;
  },
});

// The build has been saved: the site the check held can go.
export const settled = internalMutation({
  args: { id: v.id("designReviews") },
  handler: async (ctx, { id }): Promise<null> => {
    const review = await ctx.db.get(id);
    if (review?.status === "passed") await end(ctx, review, "passed");
    return null;
  },
});

async function stop(ctx: ActionCtx, id: Id<"designReviews">, reason: string) {
  await ctx.runMutation(internal.designReview.fail, { id, reason });
}

const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
function outOfRounds(revisions: number) {
  const count = COUNTS[revisions] ?? String(revisions);
  const after = revisions === 0 ? "" : ` after ${count} ${revisions === 1 ? "round" : "rounds"} of changes`;
  return `The header, menu and footer still didn't pass the design check${after}, so this build wasn't saved. Try again.`;
}

// The check itself: the reviewer's verdict on the site as it stands.
export const check = internalAction({
  args: { id: v.id("designReviews") },
  handler: async (ctx, { id }): Promise<null> => {
    const review = await ctx.runMutation(internal.designReview.claim, { id, step: "checking" });
    if (!review) return null;
    const trace = providerTrace(ctx, review.runId, review.userId);
    const site = siteOf(review);
    const round = review.round;
    let verdict: Verdict | null = null;
    const unnamed = unnamedParts(review.clones);
    if (unnamed.length) {
      // Nothing to compare against, so no model is asked to pretend there is.
      verdict = unnamedVerdict(unnamed, Boolean(review.clones?.trim()));
      await trace.note({
        phase: "design_review",
        label: `Design check, round ${round}: no Awwwards original is named for ${partList(unnamed)}`,
        level: "warn",
        status: "reviewing",
        detail: { round },
      });
    } else {
      await trace.note({
        phase: "design_review",
        label: `Design check, round ${round}: the reviewer is comparing the header, menu and footer with their originals`,
        status: "reviewing",
        detail: { round },
      });
      try {
        const reply = await callProvider(
          reviewMessages({ siteName: review.siteName, clones: review.clones ?? "", site, round, lastFixes: review.fixes }),
          undefined,
          REVIEW_BUDGET_MS,
          trace,
          "review",
        );
        verdict = readVerdict(reply);
        if (!verdict) {
          await trace.note({ phase: "design_review_error", label: "The reviewer answered without a verdict", level: "warn", detail: { round, replyChars: reply.length } });
        }
      } catch (error) {
        await trace.note({ phase: "design_review_error", label: `The reviewer could not answer: ${describe(error)}`, level: "warn", detail: { round } });
      }
      if (!verdict) {
        const next = await ctx.runMutation(internal.designReview.stumbled, { id, step: "checking" });
        if (next === "stop") {
          await stop(ctx, id, "The design check couldn't reach a verdict on the header, menu and footer, so this build wasn't saved. Try again.");
        }
        return null;
      }
    }
    const differ = PARTS.filter(({ part }) => !verdict.parts[part].equal).map(({ part }) => part);
    await trace.note({
      phase: "design_verdict",
      label: verdict.equal
        ? `Design check, round ${round}: the reviewer agrees the header, menu and footer match their originals`
        : `Design check, round ${round}: ${partList(differ)} ${differ.length === 1 ? "does" : "do"} not match ${differ.length === 1 ? "its original" : "their originals"} yet`,
      level: verdict.equal ? "info" : "warn",
      detail: { round },
    });
    const next = await ctx.runMutation(internal.designReview.judged, {
      id,
      verdict: {
        equal: verdict.equal,
        header: verdict.parts.header.equal,
        menu: verdict.parts.menu.equal,
        footer: verdict.parts.footer.equal,
        originals: PARTS.map(({ part }) => verdict.parts[part].original),
        fixes: verdict.fixes,
      },
    });
    if (next === "exhausted") {
      await stop(ctx, id, outOfRounds(revisionsAllowed()));
      return null;
    }
    if (next !== "passed") return null;
    try {
      await land(ctx, trace, review, site);
    } catch (error) {
      await stop(ctx, id, describe(error));
      return null;
    }
    await ctx.runMutation(internal.designReview.settled, { id });
    return null;
  },
});

// The save the build was going to make before the check held it.
async function land(ctx: ActionCtx, trace: ProviderTrace, review: Review, site: BuiltSite) {
  if (review.source === "onboarding" && review.onboardingId && review.attempt !== undefined) {
    await finishOnboardingBuild(ctx, trace, {
      id: review.onboardingId,
      attempt: review.attempt,
      runId: review.runId,
      userId: review.userId,
      result: { siteId: review.siteId, holdId: review.holdId, assistantId: review.assistantId, requestKind: review.requestKind, epoch: review.epoch },
      rebuild: review.rebuild ?? false,
      site,
      summary: review.summary,
      clones: review.clones,
    });
    return;
  }
  await finishThreadBuild(ctx, trace, {
    runId: review.runId,
    userId: review.userId,
    siteId: review.siteId,
    assistantId: review.assistantId,
    holdId: review.holdId,
    requestKind: review.requestKind,
    epoch: review.epoch,
    siteName: review.siteName,
    prompt: review.prompt ?? "",
    remember: review.remember ?? false,
    blockedNote: review.blockedNote,
    site,
    summary: review.summary,
    clones: review.clones,
  });
}

// Why a rework cannot be used, in words the design agent can put right.
class Unusable extends Error {}

// The design agent's rework, read against the site it reworked. A site in
// pages keeps every page the reply did not send back; its new shell has to be
// whole, written out in full, and still style everything the pages use.
function reworkOf(reply: string, before: BuiltSite): { site: BuiltSite; clones?: string } {
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
    return { site: { shell: back.shell, pages }, clones: back.clones };
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
  return { site, clones: parsed.clones };
}

// The design agent, given its work back with the reviewer's fixes.
export const revise = internalAction({
  args: { id: v.id("designReviews") },
  handler: async (ctx, { id }): Promise<null> => {
    const review = await ctx.runMutation(internal.designReview.claim, { id, step: "revising" });
    if (!review) return null;
    const trace = providerTrace(ctx, review.runId, review.userId);
    const before = siteOf(review);
    await trace.note({
      phase: "design_revision",
      label: `Sent back to the design agent after round ${review.round} of the design check`,
      status: "calling",
      detail: { round: review.round },
    });
    try {
      const request = reworkRequest({ fixes: review.fixes, shellOnly: hasPages(before), problem: review.problem });
      const reply = await callProvider(designAgentTurn(review.siteName, before, review.clones, request), undefined, undefined, trace, "build");
      const back = reworkOf(reply, before);
      await trace.note({
        phase: "design_revision_done",
        label: "The design agent sent back its rework",
        detail: { round: review.round, htmlChars: (back.site.shell ?? back.site.html ?? "").length },
      });
      await ctx.runMutation(internal.designReview.reworked, { id, ...back.site, clones: back.clones });
    } catch (error) {
      const problem = error instanceof Unusable ? error.message : undefined;
      await trace.note({
        phase: "design_revision_error",
        label: `The rework could not be used: ${problem ?? describe(error)}`,
        level: "warn",
        detail: { round: review.round },
      });
      const next = await ctx.runMutation(internal.designReview.stumbled, { id, step: "revising", problem });
      if (next === "stop") {
        await stop(ctx, id, "The design agent couldn't rework the header, menu and footer, so this build wasn't saved. Try again.");
      }
    }
    return null;
  },
});

// What the reviewer said about recent builds, for whoever runs the
// deployment: `npx convex run designReview:inspect`. The originals the design
// agent named, each round's verdict and the fixes asked for. Never a page.
export const inspect = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("designReviews").order("desc").take(KEEP_REVIEWS);
    return rows.map((row) => ({
      id: row._id,
      source: row.source,
      siteName: row.siteName,
      status: row.status,
      round: row.round,
      clones: row.clones ?? null,
      verdicts: row.verdicts,
      error: row.error ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});
