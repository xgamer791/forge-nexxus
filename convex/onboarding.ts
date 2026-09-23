import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireMemberId } from "./access";
import { designSource, siteParts, withParts, type BuiltSite } from "./pages";
import { currentPlan, holdCredits, releaseHold, settleHold } from "./billing";
import type { RequestKind } from "./plans";
import { failOpenRun, openRun, providerTrace, recordEvent, recordLastSign, type ProviderTrace } from "./diagnostics";
import { builtSite, callProvider, chatRoute, describe, parseReply } from "./generate";
import { DESIGN_GOD } from "./designgod";
import { FED } from "./fed";
import { inventSample, sampleRebuilds } from "./sampleBusiness";
import { isAdminEmail } from "./admins";
import { FORGE_MD } from "./forgeMd";
import { fulfilImages, wantsImages, imageRoute } from "./images";
import { assertDesignRules, isMeasured, NOT_MEASURED, researchDesign } from "./siteDesign";
import { briefFile, FINAL_STEP, QUESTIONS } from "./onboardingQuestions";

// The words and the pictures share an action's ten minutes. The text gets the
// larger part -- a reply is never cut off for being slow, only when the
// platform's own clock is about to run out -- and the watchdog sits just
// inside that limit, so it only ever speaks for a build that died without
// saying so.
const TEXT_BUDGET_MS = 480000;
const RETRY_FLOOR_MS = 120000;
const WATCHDOG_MS = 570000;
// While a queued attempt's step runs, its action beats at least this often.
// An attempt quiet for longer has lost its step: the platform can drop a
// scheduled action across a deploy or a restart, and nothing else would ever
// start it again (see `rescue`).
const HEARTBEAT_MS = 20000;
const STEP_QUIET_MS = 90000;
// How many times a lost step is started again before the attempt stops.
const MOST_RESTARTS = 3;
const RESCUE_BATCH = 25;
const DID_NOT_START = "The build didn’t start, so no credits were used. Try building again";
const step = v.union(v.literal("research"), v.literal("build"));

async function owned(ctx: MutationCtx | QueryCtx, id: Id<"siteOnboarding">) {
  const userId = await requireMemberId(ctx);
  const row = await ctx.db.get(id);
  if (!row || row.userId !== userId) throw new ConvexError("Website setup not found");
  return row;
}

function isActiveBuild(status: string) {
  return status === "queued" || status === "building" || status === "saving";
}

function briefReadyToBuild(row: { answers: string[]; step: number; status: string }) {
  return Boolean(row.answers[0]?.trim() && row.answers[1]?.trim()) &&
    (row.step >= FINAL_STEP || row.status === "complete" || row.status === "failed");
}

// Keep only a one-way checksum, never the discarded page. Ignore image tags
// and whitespace so replacing picture URLs cannot disguise the same page.
export async function designHash(html: string) {
  const normalized = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img\b[^>]*>/gi, "<img>").replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function scrapBriefBuild(ctx: MutationCtx, row: Doc<"siteOnboarding">) {
  const uploads = await ctx.db.query("siteUploads").withIndex("by_onboarding", q => q.eq("onboardingId", row._id)).collect();
  const files = new Set([...row.assets.map(asset => asset.storageId), ...uploads.map(upload => upload.storageId)]);
  if (row.briefStorageId) files.add(row.briefStorageId);
  for (const storageId of files) await ctx.storage.delete(storageId);
  for (const upload of uploads) await ctx.db.delete(upload._id);
  if (row.holdId) await releaseHold(ctx, row.holdId);
  await ctx.db.patch(row._id, {
    strategy: undefined, strategyRevision: undefined, strategyAnswers: undefined,
    briefStorageId: undefined, assets: [], revision: row.revision + 1,
    holdId: undefined, assistantId: undefined, error: undefined, events: [],
  });
}

async function scrapSiteBuild(ctx: MutationCtx, siteId: Id<"sites"> | undefined, userId: Id<"users">) {
  if (!siteId) return { hashes: [] };
  const site = await ctx.db.get(siteId);
  if (!site || site.userId !== userId) return { hashes: [] };
  // The design reference stays: a rebuild measures the same address again,
  // with no new search, and replaces it (siteDesign.save).
  const images = await ctx.db.query("siteImages").withIndex("by_site", q => q.eq("siteId", siteId)).collect();
  for (const image of images) {
    await ctx.storage.delete(image.storageId);
    await ctx.db.delete(image._id);
  }
  const versions = await ctx.db.query("siteVersions").withIndex("by_site", q => q.eq("siteId", siteId)).collect();
  const hashes = await Promise.all(versions.map(version => designHash(designSource(version))));
  for (const version of versions) await ctx.db.delete(version._id);
  const messages = await ctx.db.query("messages").withIndex("by_conversation", q => q.eq("conversationId", site.conversationId)).collect();
  for (const message of messages) await ctx.db.delete(message._id);
  // Release old thread jobs now; their provider calls cannot be recalled, but
  // their completion and image writes must no longer belong to this site.
  const runs = await ctx.db.query("buildRuns").withIndex("by_conversation", q => q.eq("conversationId", site.conversationId)).collect();
  for (const run of runs) {
    if (run.holdId) await releaseHold(ctx, run.holdId);
    if (!["complete", "failed"].includes(run.status)) {
      await ctx.db.patch(run._id, { status: "failed", error: "Build discarded by rebuild", endedAt: Date.now(), updatedAt: Date.now() });
    }
  }
  // A page still on its way from before the scrap belongs to the old site,
  // never to the fresh one; the epoch is what its finish checks.
  await ctx.db.patch(siteId, {
    currentVersionId: undefined,
    publishedVersionId: undefined,
    publishedAt: undefined,
    status: "draft",
    buildEpoch: (site.buildEpoch ?? 0) + 1,
    updatedAt: Date.now(),
  });
  return { hashes };
}

async function queueOnboardingBuild(
  ctx: MutationCtx,
  id: Id<"siteOnboarding">,
  row: { attempt: number; userId: Id<"users"> },
  siteId: Id<"sites">,
  label: string,
  source: "onboarding" | "rebuild" = "onboarding",
) {
  const attempt = row.attempt + 1;
  await ctx.db.patch(id, {
    siteId,
    attempt,
    status: "queued",
    dismissed: false,
    events: [{ label, at: Date.now() }],
    error: undefined,
    holdId: undefined,
    assistantId: undefined,
    queueStep: { attempt, step: "research", beatAt: Date.now(), restarts: 0 },
    updatedAt: Date.now(),
  });
  const site = await ctx.db.get(siteId);
  await openRun(ctx, {
    userId: row.userId,
    source,
    status: "queued",
    siteId,
    conversationId: site?.conversationId,
    onboardingId: id,
    attempt,
    requestKind: "generate",
  });
  await ctx.scheduler.runAfter(0, internal.onboarding.research, { id, attempt });
  await ctx.scheduler.runAfter(WATCHDOG_MS, internal.onboarding.expire, { id, attempt });
}

// A step's heartbeat while its action runs. A step the platform killed stops
// beating and the rescue starts it again; one that is only slow -- a long
// crawl, a quiet stretch in the worker -- keeps its hold.
function heartbeat(ctx: ActionCtx, args: { id: Id<"siteOnboarding">; attempt: number; lease: string }) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await ctx.runMutation(internal.onboarding.beat, args);
      } catch {
        /* A missed beat is made up by the next. */
      }
      if (!stopped) next();
    }, HEARTBEAT_MS);
  };
  next();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

// Research has its own action clock. A large reference crawl must not spend
// the writing action's 480-second budget before the model has even started.
export const research = internalAction({
  args: { id: v.id("siteOnboarding"), attempt: v.number() },
  handler: async (ctx, { id, attempt }): Promise<void> => {
    const row = await ctx.runQuery(internal.onboarding.load, { id });
    if (!row?.siteId || row.attempt !== attempt || row.status !== "queued") return;
    // One copy researches an attempt. Any other -- a restart, a retry, a
    // manual run -- stops here, and nothing it does can end the attempt.
    const lease = await ctx.runMutation(internal.onboarding.claimStep, { id, attempt, step: "research" });
    if (!lease) return;
    const stop = heartbeat(ctx, { id, attempt, lease });
    try {
      const runId = await ctx.runQuery(internal.diagnostics.findOpen, { onboardingId: id, attempt });
      if (!runId) throw new Error("The build activity log is missing");
      const trace = providerTrace(ctx, runId, row.userId);
      let answers = row.answers;
      if (row.discardedDesignHashes !== undefined && sampleRebuilds()) {
        await trace.note({ phase: "sample", label: "Inventing a San Antonio business for this rebuild" });
        const sample = await inventSample(row.answers[0] ?? "");
        answers = sample.answers;
        if (!await ctx.runMutation(internal.onboarding.adoptSample, {
          id, attempt, answers, label: `Answers replaced with ${answers[0]} in ${sample.draw.neighbourhood}`,
        })) return;
      }
      const epoch = await ctx.runQuery(internal.siteDesign.siteEpoch, { siteId: row.siteId });
      const saved = await ctx.runQuery(internal.siteDesign.forSite, { siteId: row.siteId });
      if (saved && saved.buildEpoch === epoch && isMeasured(saved)) {
        await trace.note({ phase: "research_reused", label: "Using the saved design reference" });
      } else {
        // A site that already has a reference -- from before a rebuild, or
        // from before measuring -- is measured again there, with no search.
        await researchDesign(ctx, {
          siteId: row.siteId, onboardingId: id, attempt, epoch,
          offer: answers[1] ?? "", audience: answers[2] ?? "", feel: answers[6] ?? "",
          references: answers[8] ?? "",
          ...(saved?.referenceUrl ? { referenceUrl: saved.referenceUrl } : {}),
        }, trace, lease);
      }
      await ctx.runMutation(internal.onboarding.researched, { id, attempt, lease });
    } catch (error) {
      const reason = describe(error);
      console.error("Forge design research failed:", reason);
      await ctx.runMutation(internal.onboarding.stepFailed, { id, attempt, step: "research", lease, reason });
    } finally {
      stop();
    }
  },
});

// The start of a step. One copy holds it; another copy of a step for the same
// attempt stops here and changes nothing, and so does a research once its
// attempt has moved on to the build.
export const claimStep = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), step },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { id, attempt, step }) => {
    const row = await ctx.db.get(id);
    if (!row || row.attempt !== attempt || row.status !== "queued") return null;
    const now = Date.now();
    const current = row.queueStep?.attempt === attempt ? row.queueStep : undefined;
    if (current?.lease && now - current.beatAt < STEP_QUIET_MS) return null;
    if (step === "research" && current?.step === "build") return null;
    const lease = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    await ctx.db.patch(id, { queueStep: { attempt, step, lease, beatAt: now, restarts: current?.restarts ?? 0 }, updatedAt: now });
    return lease;
  },
});

// A sign of life from the copy that holds its step.
export const beat = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), lease: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, attempt, lease }) => {
    const row = await ctx.db.get(id);
    if (!row?.queueStep || row.attempt !== attempt || row.status !== "queued" || row.queueStep.lease !== lease) return false;
    const now = Date.now();
    await ctx.db.patch(id, { queueStep: { ...row.queueStep, beatAt: now }, updatedAt: now });
    return true;
  },
});

// The research that holds its step hands the attempt to the build, once.
export const researched = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), lease: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, attempt, lease }) => {
    const row = await ctx.db.get(id);
    if (!row?.queueStep || row.attempt !== attempt || row.status !== "queued" ||
        row.queueStep.lease !== lease || row.queueStep.step !== "research") return false;
    const now = Date.now();
    await ctx.db.patch(id, { queueStep: { attempt, step: "build", beatAt: now, restarts: row.queueStep.restarts }, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.onboarding.build, { id, attempt });
    return true;
  },
});

// A step that failed ends its attempt only while it holds it: queued, or --
// for the build, past its checkpoint -- building or saving. A copy that lost
// its hold to another fails alone, and a research can never end a build.
export const stepFailed = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), step, lease: v.string(), reason: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, attempt, step, lease, reason }) => {
    const row = await ctx.db.get(id);
    if (!row || row.attempt !== attempt || row.queueStep?.lease !== lease || row.queueStep.step !== step) return false;
    const holds = row.status === "queued" || (step === "build" && (row.status === "building" || row.status === "saving"));
    if (!holds) return false;
    await stopAttempt(ctx, { id, attempt, failed: true, reason });
    return true;
  },
});

// Every half minute (crons.ts). A queued attempt that has gone quiet lost its
// step, so the step is started again from the top; the copy claims it first,
// so a step that turns out to be alive after all is left alone. An attempt
// that keeps losing its step stops, with nothing charged, before the
// watchdog would have spoken for it.
export const rescue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const quiet = await ctx.db
      .query("siteOnboarding")
      .withIndex("by_status_updated", (q) => q.eq("status", "queued").lt("updatedAt", now - STEP_QUIET_MS))
      .take(RESCUE_BATCH);
    for (const row of quiet) {
      const current = row.queueStep?.attempt === row.attempt ? row.queueStep : undefined;
      const lost = current?.step ?? "research";
      const restarts = current?.restarts ?? 0;
      const run = await ctx.db
        .query("buildRuns")
        .withIndex("by_onboarding_attempt", (q) => q.eq("onboardingId", row._id).eq("attempt", row.attempt))
        .first();
      const quietFor = Math.round((now - row.updatedAt) / 1000);
      if (restarts >= MOST_RESTARTS) {
        if (run) {
          await recordEvent(ctx, { runId: run._id, userId: row.userId, phase: "rescue_stopped", level: "error",
            label: `The ${lost} went quiet again after ${restarts} restarts, so the build stopped` });
        }
        await stopAttempt(ctx, { id: row._id, attempt: row.attempt, failed: true, reason: DID_NOT_START });
        continue;
      }
      await ctx.db.patch(row._id, { queueStep: { attempt: row.attempt, step: lost, beatAt: now, restarts: restarts + 1 }, updatedAt: now });
      if (run) {
        await recordEvent(ctx, { runId: run._id, userId: row.userId, phase: "rescued", level: "warn",
          label: `Started the ${lost} again: nothing had been heard from it for ${quietFor}s` });
      }
      await ctx.scheduler.runAfter(0, lost === "build" ? internal.onboarding.build : internal.onboarding.research, { id: row._id, attempt: row.attempt });
    }
    return null;
  },
});

// sample-business block: while rebuilds invent their own business, the
// deployment's admins test without the questions. They stay on the dashboard,
// Rebuild is always offered, and a rebuild with no brief to rebuild from makes
// one for the invented business to fill. Every other member is unaffected.
async function testingRebuilds(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  if (!sampleRebuilds()) return false;
  const user = await ctx.db.get(userId);
  return isAdminEmail(user?.email);
}

export const state = query({
  args: {},
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) return null;
    const plan = await currentPlan(ctx, userId);
    const sites = await ctx.db.query("sites").withIndex("by_user_updated", q => q.eq("userId", userId)).collect();
    const hasWebsite = sites.some(site => Boolean(site.currentVersionId));
    const rows = await ctx.db.query("siteOnboarding").withIndex("by_user", q => q.eq("userId", userId)).collect();
    const open = rows.filter(r => !r.dismissed);
    const testing = await testingRebuilds(ctx, userId);
    const newestOpen = open.find(r => isActiveBuild(r.status)) ?? open.sort((a, b) => b.createdAt - a.createdAt)[0];
    // sample-business block: a tester never lands on the questions.
    const row = testing && newestOpen?.status === "questions" ? undefined : newestOpen;
    // Never expose the agent's strategy, provider details, or private brief.
    const draft = row ? { id: row._id, siteId: row.siteId, answers: row.answers, step: row.step,
      status: row.status, events: row.events, error: row.error,
      assets: row.assets.map(a => ({ name: a.name, storageId: a.storageId })) } : null;
    const canRebuild = plan.key !== "free" && !rows.some(r => isActiveBuild(r.status)) && (testing || rows.some(briefReadyToBuild));
    // The questions come first for a paid member with nothing built -- but a
    // build that failed is not a locked door. Someone who stepped away from
    // one reaches their dashboard, and New site brings the saved brief back.
    const newest = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const leftFailedBuild = !row && newest?.status === "failed";
    return { userId, isFree: plan.key === "free", required: !testing && plan.key !== "free" && !hasWebsite && !leftFailedBuild, hasWebsite, draft, canRebuild, testing };
  },
});

export const start = mutation({
  args: {},
  handler: async ctx => {
    const userId = await requireMemberId(ctx);
    const rows = await ctx.db.query("siteOnboarding").withIndex("by_user", q => q.eq("userId", userId)).collect();
    const existing = rows.find(r => !r.dismissed);
    if (existing) return existing._id;
    // A brief that was never built -- still being answered, or left after a
    // failed build -- comes back as it was, so nobody answers twice.
    const resume = rows.filter(r => r.status === "questions" || r.status === "failed").sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (resume) { await ctx.db.patch(resume._id, { dismissed: false, updatedAt: Date.now() }); return resume._id; }
    const now = Date.now();
    return await ctx.db.insert("siteOnboarding", { userId, answers: QUESTIONS.map(() => ""),
      step: 0, revision: 0, assets: [], status: "questions", attempt: 0, dismissed: false,
      events: [], createdAt: now, updatedAt: now });
  },
});

export const save = mutation({
  args: { id: v.id("siteOnboarding"), index: v.number(), answer: v.string(), advance: v.boolean() },
  handler: async (ctx, { id, index, answer, advance }) => {
    const row = await owned(ctx, id);
    // Saving an answer on a brief whose build failed reopens its questions:
    // what went wrong may be in the answers, and they are the member's to fix.
    const reopening = row.status === "failed";
    if (row.status !== "questions" && !reopening) throw new ConvexError("This brief is already being built");
    if (!Number.isInteger(index) || index < 0 || index >= QUESTIONS.length) throw new ConvexError("Unknown question");
    const question = QUESTIONS[index];
    const value = answer.trim();
    if (value.length > question.limit) throw new ConvexError(`Keep this answer under ${question.limit} characters`);
    if (advance && "required" in question && question.required && !value) throw new ConvexError("Add a short answer to continue");
    const answers = [...row.answers];
    answers[index] = value;
    const revision = row.revision + 1;
    const strategyAnswers = row.strategyAnswers ?? QUESTIONS.map(() => null as string | null);
    const developStrategy = advance && strategyAnswers[index] !== value;
    if (advance) strategyAnswers[index] = value;
    await ctx.db.patch(id, { answers, revision, strategyAnswers, step: advance ? Math.min(index + 1, FINAL_STEP) : index, updatedAt: Date.now(),
      ...(reopening ? { status: "questions" as const, error: undefined } : {}) });
    // Each submitted answer gives the agent an updated snapshot, even when a
    // later answer arrives before it finishes. Only the newest strategy wins.
    if (developStrategy) await ctx.scheduler.runAfter(0, internal.onboarding.strategize, { id, revision, answers });
    return { revision };
  },
});

export const uploadUrl = mutation({
  args: { id: v.id("siteOnboarding") },
  handler: async (ctx, { id }) => {
    const row = await owned(ctx, id);
    if (row.status !== "questions" || row.assets.length >= 8) throw new ConvexError("You can add up to eight files before building");
    return await ctx.storage.generateUploadUrl();
  },
});
export const attach = mutation({
  args: { id: v.id("siteOnboarding"), storageId: v.id("_storage"), name: v.string() },
  handler: async (ctx, { id, storageId, name }) => {
    const row = await owned(ctx, id);
    if (row.status !== "questions" || row.assets.length >= 8) throw new ConvexError("You can add up to eight files before building");
    const owner = await ctx.db.query("siteUploads").withIndex("by_storage", q => q.eq("storageId", storageId)).unique();
    if (owner && (owner.userId !== row.userId || owner.onboardingId !== id)) throw new ConvexError("Upload this file for this website first");
    const meta = await ctx.db.system.get(storageId);
    const type = meta?.contentType ?? "";
    if (!meta || !["image/png", "image/jpeg", "image/webp", "text/plain", "text/markdown"].includes(type) || meta.size > (type.startsWith("text/") ? 100000 : 5000000)) {
      throw new ConvexError("Use PNG, JPG or WebP under 5 MB, or text files under 100 KB");
    }
    if (!row.assets.some(a => a.storageId === storageId)) {
      if (!owner) await ctx.db.insert("siteUploads", { userId: row.userId, onboardingId: id, storageId });
      await ctx.db.patch(id, { assets: [...row.assets, { storageId, name: name.slice(0, 160), type }], updatedAt: Date.now() });
    }
  },
});
export const detach = mutation({
  args: { id: v.id("siteOnboarding"), storageId: v.id("_storage") },
  handler: async (ctx, { id, storageId }) => {
    const row = await owned(ctx, id);
    if (row.status !== "questions") throw new ConvexError("The build has already started");
    if (!row.assets.some(a => a.storageId === storageId)) return;
    await ctx.db.patch(id, { assets: row.assets.filter(a => a.storageId !== storageId), updatedAt: Date.now() });
    const upload = await ctx.db.query("siteUploads").withIndex("by_storage", q => q.eq("storageId", storageId)).unique();
    if (upload?.userId === row.userId) await ctx.db.delete(upload._id);
    await ctx.storage.delete(storageId);
  },
});

export const submit = mutation({
  args: { id: v.id("siteOnboarding") },
  handler: async (ctx, { id }) => {
    const row = await owned(ctx, id);
    if (["queued", "building", "saving", "complete"].includes(row.status)) return;
    const plan = await currentPlan(ctx, row.userId);
    if (plan.key === "free") throw new ConvexError("Choose a paid plan to build your website. Your answers are saved.");
    if (row.step < FINAL_STEP || !row.answers[0]?.trim() || !row.answers[1]?.trim()) throw new ConvexError("Finish your website questions first");
    // A retry builds into the site the first attempt made, as long as it is
    // still there; otherwise the build would fail on a site nobody can find.
    const kept = row.siteId ? await ctx.db.get(row.siteId) : null;
    let siteId = kept?.userId === row.userId ? kept._id : undefined;
    if (!siteId) {
      const sites = await ctx.db.query("sites").withIndex("by_user_updated", q => q.eq("userId", row.userId)).collect();
      // Reuse a legacy empty planning thread for a first site. Such a thread
      // must neither bypass onboarding nor consume the last plan slot.
      const empty = sites.find(site => !site.currentVersionId);
      if (empty) {
        siteId = empty._id;
        await ctx.db.patch(siteId, { name: row.answers[0] });
        await ctx.db.patch(empty.conversationId, { title: row.answers[0] });
      } else {
        if (plan.maxSites !== null && sites.length >= plan.maxSites) throw new ConvexError("Your plan has reached its website limit");
        const conversationId = await ctx.db.insert("conversations", { userId: row.userId, title: row.answers[0], updatedAt: Date.now() });
        siteId = await ctx.db.insert("sites", { userId: row.userId, conversationId, name: row.answers[0], status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
      }
    }
    await queueOnboardingBuild(ctx, id, row, siteId, "Answers submitted");
  },
});

// Scraps the live site and builds a new one from the saved answers, then
// puts the member back on the building screen. The brief stays; the old
// page, pictures and thread do not.
export const rebuild = mutation({
  // `fresh` (testing only) makes a new site rather than rebuilding one.
  args: { siteId: v.optional(v.id("sites")), fresh: v.optional(v.boolean()) },
  returns: v.id("siteOnboarding"),
  handler: async (ctx, { siteId: requestedSiteId, fresh }) => {
    const userId = await requireMemberId(ctx);
    const testing = await testingRebuilds(ctx, userId);
    if (fresh && !testing) throw new ConvexError("Start a new site from its questions");
    const plan = await currentPlan(ctx, userId);
    if (plan.key === "free") throw new ConvexError("Choose a paid plan to rebuild your website. Your answers are saved.");
    const rows = await ctx.db.query("siteOnboarding").withIndex("by_user", q => q.eq("userId", userId)).collect();
    if (rows.some(r => isActiveBuild(r.status))) throw new ConvexError("Your website is still building");
    const sites = await ctx.db.query("sites").withIndex("by_user_updated", q => q.eq("userId", userId)).collect();
    // Old clients may omit the target only when there is no ambiguity. Never
    // choose another site's brief merely because somebody edited it last.
    if (!fresh && !requestedSiteId && sites.length > 1) throw new ConvexError("Select the website you want to rebuild, then try again.");
    const target = fresh ? undefined : requestedSiteId ? sites.find(site => site._id === requestedSiteId) : sites[0];
    if (requestedSiteId && !target) throw new ConvexError("Website not found");
    const ready = rows.filter(briefReadyToBuild).sort((a, b) => b.updatedAt - a.updatedAt);
    const linked = target ? ready.filter(row => row.siteId === target._id) : [];
    const orphaned = ready.filter(row => !row.siteId || !sites.some(site => site._id === row.siteId));
    const found = fresh ? undefined : linked[0] ?? (sites.length <= 1 && orphaned.length === 1 ? orphaned[0] : undefined);
    // sample-business block: a tester's rebuild needs no answers of its own;
    // the build invents the business and fills this brief before it starts.
    const brief = found ?? (testing ? await blankBrief(ctx, userId, target?._id) : undefined);
    if (!brief) throw new ConvexError("Finish your website questions first");
    const now = Date.now();
    for (const other of rows) {
      if (other._id !== brief._id && !other.dismissed) {
        await ctx.db.patch(other._id, { dismissed: true, updatedAt: now });
      }
    }
    // Purge every brief attached to this site, including dismissed legacy
    // briefs that normal chat's by_site lookup could otherwise pick up.
    const related = rows.filter(row => row._id === brief._id || (target && row.siteId === target._id));
    for (const row of related) await scrapBriefBuild(ctx, row);
    const { hashes } = await scrapSiteBuild(ctx, target?._id, userId);
    await ctx.db.patch(brief._id, {
      discardedDesignHashes: [...new Set([...related.flatMap(row => row.discardedDesignHashes ?? []), ...hashes])].slice(-64),
    });
    let siteId = target?._id;
    if (!siteId) {
      if (plan.maxSites !== null && sites.length >= plan.maxSites) throw new ConvexError("Your plan has reached its website limit");
      const conversationId = await ctx.db.insert("conversations", { userId, title: brief.answers[0] || "New website", updatedAt: now });
      siteId = await ctx.db.insert("sites", { userId, conversationId, name: brief.answers[0] || "New website", status: "draft", createdAt: now, updatedAt: now });
    }
    // sample-business block: the answers are about to be replaced, so the log says so.
    await queueOnboardingBuild(ctx, brief._id, brief, siteId, sampleRebuilds() ? "Rebuilding as a new San Antonio business" : "Rebuilding from your answers", "rebuild");
    return brief._id;
  },
});

// sample-business block: an empty brief for a tester's rebuild, which the
// build fills with an invented business before anything reads it.
async function blankBrief(ctx: MutationCtx, userId: Id<"users">, siteId: Id<"sites"> | undefined) {
  const now = Date.now();
  const id = await ctx.db.insert("siteOnboarding", { userId, answers: QUESTIONS.map(() => ""),
    step: FINAL_STEP, revision: 0, assets: [], status: "questions", attempt: 0, dismissed: false,
    events: [], createdAt: now, updatedAt: now, ...(siteId ? { siteId } : {}) });
  return (await ctx.db.get(id))!;
}

async function wipeBuildProgress(
  ctx: MutationCtx,
  siteId: Id<"sites">,
  userId: Id<"users">,
  since: number,
) {
  const site = await ctx.db.get(siteId);
  if (!site || site.userId !== userId) return;
  const versions = await ctx.db
    .query("siteVersions")
    .withIndex("by_site", (q) => q.eq("siteId", siteId))
    .collect();
  const kept = versions.filter((version) => version.createdAt < since).sort((a, b) => a.createdAt - b.createdAt);
  for (const version of versions) {
    if (version.createdAt >= since) await ctx.db.delete(version._id);
  }
  const images = await ctx.db.query("siteImages").withIndex("by_site", (q) => q.eq("siteId", siteId)).collect();
  for (const image of images) {
    if (image.createdAt >= since) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete(image._id);
    }
  }
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", site.conversationId))
    .collect();
  if (!site.currentVersionId || kept.length === 0) {
    for (const message of messages) await ctx.db.delete(message._id);
  } else {
    const pending = messages.filter((message) => message.status === "pending");
    for (const message of pending) await ctx.db.delete(message._id);
    const users = messages
      .filter((message) => message.role === "user")
      .sort((a, b) => b._creationTime - a._creationTime);
    if (users[0] && users[0]._creationTime >= since) await ctx.db.delete(users[0]._id);
  }
  const latest = kept.at(-1);
  await ctx.db.patch(siteId, {
    currentVersionId: latest?._id,
    publishedVersionId: site.publishedVersionId && kept.some((version) => version._id === site.publishedVersionId)
      ? site.publishedVersionId
      : undefined,
    publishedAt: latest && site.publishedVersionId && kept.some((version) => version._id === site.publishedVersionId)
      ? site.publishedAt
      : undefined,
    status: latest && site.publishedVersionId && kept.some((version) => version._id === site.publishedVersionId)
      ? site.status
      : "draft",
    buildEpoch: (site.buildEpoch ?? 0) + 1,
    updatedAt: Date.now(),
  });
}

// Stops an in-flight build, discards the page it was writing, and opens the
// dashboard. The brief stays so they can rebuild; the half-finished work does not.
export const cancel = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireMemberId(ctx);
    const now = Date.now();
    const rows = await ctx.db.query("siteOnboarding").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const active = rows.filter((row) => isActiveBuild(row.status));
    const sites = await ctx.db.query("sites").withIndex("by_user_updated", (q) => q.eq("userId", userId)).collect();
    const targets = new Map<Id<"sites">, number>();
    for (const row of active) {
      if (row.siteId) targets.set(row.siteId, row.events[0]?.at ?? now);
    }
    for (const site of sites) {
      const thread = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", site.conversationId))
        .collect();
      const pending = thread.filter((message) => message.status === "pending");
      if (pending.length === 0) continue;
      const started = Math.min(...pending.map((message) => message._creationTime));
      const previous = targets.get(site._id);
      targets.set(site._id, previous === undefined ? started : Math.min(previous, started));
    }
    if (targets.size === 0 && sites[0]) targets.set(sites[0]._id, now);
    for (const [siteId, since] of targets) {
      await wipeBuildProgress(ctx, siteId, userId, since);
    }
    for (const row of active) {
      if (row.holdId) await releaseHold(ctx, row.holdId);
      if (row.assistantId && (await ctx.db.get(row.assistantId))) await ctx.db.delete(row.assistantId);
      await failOpenRun(ctx, { onboardingId: row._id, attempt: row.attempt, error: "Build cancelled" });
      await ctx.db.patch(row._id, {
        status: "failed",
        dismissed: true,
        error: undefined,
        holdId: undefined,
        assistantId: undefined,
        events: [],
        updatedAt: now,
      });
    }
    return null;
  },
});

export const dismiss = mutation({
  args: { id: v.id("siteOnboarding") },
  handler: async (ctx, { id }) => {
    const row = await owned(ctx, id);
    if (["queued", "building", "saving"].includes(row.status)) throw new ConvexError("Your website is still building");
    const plan = await currentPlan(ctx, row.userId);
    const sites = await ctx.db.query("sites").withIndex("by_user_updated", q => q.eq("userId", row.userId)).collect();
    // A failed build is never a locked door: the member can always step out to
    // the dashboard, and their brief is there when they come back to it.
    if (row.status !== "failed" && plan.key !== "free" && !sites.some(s => s.currentVersionId)) throw new ConvexError("Build your first website to open the dashboard");
    await ctx.db.patch(id, { dismissed: true, updatedAt: Date.now() });
  },
});

export const load = internalQuery({ args: { id: v.id("siteOnboarding") }, handler: (ctx, { id }) => ctx.db.get(id) });

export const strategyHold = internalMutation({
  args: { id: v.id("siteOnboarding"), revision: v.number() },
  handler: async (ctx, { id, revision }) => {
    const row = await ctx.db.get(id);
    if (!row || row.dismissed || row.revision !== revision) return null;
    return await holdCredits(ctx, row.userId, "chat");
  },
});
export const strategySaved = internalMutation({
  args: { id: v.id("siteOnboarding"), revision: v.number(), strategy: v.optional(v.string()), holdId: v.id("creditHolds") },
  handler: async (ctx, { id, revision, strategy, holdId }) => {
    const row = await ctx.db.get(id);
    const active = row && !row.dismissed && row.revision === revision;
    if (strategy && active && revision > (row.strategyRevision ?? -1)) {
      await ctx.db.patch(id, { strategy, strategyRevision: revision });
    }
    if (strategy && active) await settleHold(ctx, holdId);
    else await releaseHold(ctx, holdId);
  },
});
// The brief is short, but it is written by a model that thinks first and
// bills that thinking against the same ceiling, so the room here is for both.
// What is kept is the brief: it rides inside every build prompt, so a model
// that answered at length is cut to a brief's length before it is stored.
const STRATEGY_MAX_TOKENS = 32000;
const STRATEGY_CHARS = 6000;

export const strategize = internalAction({
  args: { id: v.id("siteOnboarding"), revision: v.number(), answers: v.array(v.string()) },
  handler: async (ctx, { id, revision, answers }): Promise<void> => {
    const row = await ctx.runQuery(internal.onboarding.load, { id });
    if (!row || row.dismissed || row.revision !== revision) return;
    let hold;
    try { hold = await ctx.runMutation(internal.onboarding.strategyHold, { id, revision }); } catch { return; }
    if (!hold) return;
    let strategy: string | undefined;
    try {
      const memory = await ctx.runQuery(internal.memory.note, { userId: row.userId });
      strategy = await callProvider([
        { role: "system", content: FORGE_MD },
        { role: "system", content: DESIGN_GOD },
        { role: "system", content: FED },
        { role: "system", content: "You are Forge's private website strategist. After each onboarding answer, refine a concise actionable build brief: who this is for, what the site has to get them to do, what it must cover, what the copy should lead with, and the feel the brand asks for. Never ask questions. Never write user-facing commentary." },
        ...(memory ? [{ role: "system" as const, content: memory }] : []),
        { role: "user", content: briefFile(answers, row.strategy ?? "", []) },
      ], STRATEGY_MAX_TOKENS, undefined, undefined, "strategy");
    } catch { /* The final build can derive its strategy directly from the complete brief. */ }
    await ctx.runMutation(internal.onboarding.strategySaved, { id, revision, strategy: strategy?.slice(0, STRATEGY_CHARS), holdId: hold.holdId });
  },
});

export const checkpoint = internalMutation({
  args: {
    id: v.id("siteOnboarding"), attempt: v.number(), storageId: v.optional(v.id("_storage")), saving: v.optional(v.boolean()),
    // The build's own first checkpoint names its hold: only that copy moves the attempt on.
    lease: v.optional(v.string()),
  },
  handler: async (ctx, { id, attempt, storageId, saving, lease }) => {
    const row = await ctx.db.get(id);
    if (!row || row.attempt !== attempt || !["queued", "building"].includes(row.status)) return false;
    if (lease !== undefined && (row.status !== "queued" || row.queueStep?.lease !== lease)) return false;
    if (storageId && row.briefStorageId) await ctx.storage.delete(row.briefStorageId);
    const patch = storageId ? { briefStorageId: storageId } : {};
    await ctx.db.patch(id, { ...patch, status: saving ? "saving" : "building", updatedAt: Date.now(),
      events: [...row.events, { label: saving ? "Website received from the agent" : "Build brief saved and read", at: Date.now() }] });
    return true;
  },
});

// A milestone inside the build, for the progress log. It changes nothing but
// what the member reads, and a stale attempt cannot write one.
export const milestone = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), label: v.string() },
  handler: async (ctx, { id, attempt, label }) => {
    const row = await ctx.db.get(id);
    if (!row || row.attempt !== attempt || row.status !== "building") return false;
    await ctx.db.patch(id, { updatedAt: Date.now(), events: [...row.events, { label, at: Date.now() }] });
    return true;
  },
});

const BUILD_ORDER = "This is an onboarding BUILD. Read the attached website-build-brief.md, work privately, and return the finished site now. Do not ask questions, discuss your plan, or reply with planning prose.";
const BUILD_AGAIN = "Your last reply did not contain a complete website. Return the whole website now: one sentence, then the shell in a ```html shell block that ends with </html>, then each page in its own ```html path=\"/about\" title=\"About\" block, every block closed with its fence. No planning prose, and keep the CSS lean enough to finish.";
const DIFFERENT_BUILD = "The page you returned matched a discarded design and was rejected. Create a genuinely different page composition from the business answers. Start the HTML and CSS again; changing pictures or whitespace is not a new design. Return a complete website now.";

// The page, asked for until it is whole. A reply that talked instead of
// building, or stopped short of </html>, is worth one more go while there is
// time for it; a provider that refused will only say the same thing twice.
async function writePage(
  messages: Parameters<typeof callProvider>[0],
  deadline: number,
  trace?: Parameters<typeof callProvider>[3],
  discardedDesignHashes: string[] = [],
  redesign?: { requireImages: boolean },
) {
  let shortfall: unknown;
  let repeated = false;
  for (let round = 0; round < 2; round += 1) {
    const remaining = deadline - Date.now();
    if (round > 0 && remaining < RETRY_FLOOR_MS) break;
    try {
      const reply = await callProvider(
        [...messages.slice(0, -1),
          ...(redesign?.requireImages ? [{ role: "system" as const, content: "Include at least one new subject-relevant photograph or illustration using an img with src=\"forge-image:1\" and a detailed data-forge-image prompt. Do not substitute an inline SVG diagram, CSS drawing, gradient or decorative icon for the principal subject image." }] : []),
          ...(round > 0 ? [{ role: "system" as const, content: repeated ? DIFFERENT_BUILD : BUILD_AGAIN }] : []),
          messages[messages.length - 1],
        ],
        undefined,
        remaining,
        trace,
        "build",
      );
      const parsed = parseReply(reply);
      const site = builtSite(parsed);
      if (site) {
        const duplicate = discardedDesignHashes.includes(await designHash(designSource(site)));
        const requestedPicture = (siteParts(site).join("\n").match(/<img\b[^>]*>/gi) ?? [])
          .some(tag => /\bdata-forge-image\s*=\s*["'][^"']+/i.test(tag));
        if (!duplicate && (!redesign?.requireImages || requestedPicture)) return { site, summary: parsed.summary, clones: parsed.clones };
        if (!duplicate) {
          shortfall = new Error("The rebuild did not include its required new imagery. Try rebuilding again.");
          continue;
        }
        repeated = true;
        shortfall = new Error("The model repeated the discarded design. Rebuild again to request a new one.");
        continue;
      }
      shortfall = new Error("The agent did not return a website");
    } catch (error) {
      if (error instanceof ConvexError || !(error instanceof Error) || !/complete page|complete site|empty reply/i.test(error.message)) throw error;
      shortfall = error;
    }
  }
  throw shortfall ?? new Error("The agent did not return a website");
}

// sample-business block: a rebuild's invented answers replace the old ones,
// and the site and its thread take the new name. A stale attempt writes nothing.
export const adoptSample = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), answers: v.array(v.string()), label: v.string() },
  handler: async (ctx, { id, attempt, answers, label }) => {
    const row = await ctx.db.get(id);
    if (!row || row.attempt !== attempt || row.status !== "queued") return false;
    await ctx.db.patch(id, { answers, strategy: undefined, strategyRevision: undefined, strategyAnswers: undefined,
      step: FINAL_STEP, revision: row.revision + 1, updatedAt: Date.now(), events: [...row.events, { label, at: Date.now() }] });
    const site = row.siteId ? await ctx.db.get(row.siteId) : null;
    if (site) {
      await ctx.db.patch(site._id, { name: answers[0] });
      await ctx.db.patch(site.conversationId, { title: answers[0] });
    }
    return true;
  },
});

// The end of an onboarding build: the pictures the page asked for, the save,
// and the log. A build comes here from the layout check (`designGate.ts`)
// once it passes, with the site it passed.
export async function finishOnboardingBuild(
  ctx: ActionCtx,
  trace: ProviderTrace,
  build: {
    id: Id<"siteOnboarding">;
    attempt: number;
    runId: Id<"buildRuns">;
    userId: Id<"users">;
    result: { siteId: Id<"sites">; holdId: Id<"creditHolds">; assistantId: Id<"messages">; requestKind: RequestKind; epoch: number };
    rebuild: boolean;
    site: BuiltSite;
    summary: string;
    clones?: string;
  },
) {
  const { id, attempt, runId } = build;
  // The pictures the page asked for are made before it is saved, so the
  // first version a member opens is the finished one.
  let site: BuiltSite = build.site;
  let imageWanted = 0;
  let imageMade = 0;
  if (wantsImages(siteParts(site).join("\n"))) {
    if (!await ctx.runMutation(internal.onboarding.milestone, { id, attempt, label: "Page written" })) return;
    await trace.note({ phase: "images", label: "Making pictures", status: "images" });
    const pictures = await fulfilImages(ctx, { parts: siteParts(site), userId: build.userId, siteId: build.result.siteId, epoch: build.result.epoch });
    site = withParts(site, pictures.parts);
    imageWanted = pictures.wanted;
    imageMade = pictures.made;
    if (pictures.made) await ctx.runMutation(internal.onboarding.milestone, { id, attempt, label: "Pictures made for your site" });
    await trace.note({
      phase: "images_done",
      label: pictures.made ? "Pictures made for your site" : "No new pictures to make",
      detail: { imageWanted: pictures.wanted, imageMade: pictures.made },
    });
  }
  if (build.rebuild && imageRoute().apiKey && imageMade === 0) {
    throw new Error("The new pictures could not be generated. The rebuild was not published. Try again.");
  }
  if (!await ctx.runMutation(internal.onboarding.checkpoint, { id, attempt, saving: true })) {
    await ctx.runMutation(internal.diagnostics.close, { runId, status: "failed", error: "This build is no longer active" });
    return;
  }
  const siteChars = siteParts(site).join("").length;
  await trace.note({ phase: "saving", label: "Saving your website", status: "saving", detail: { htmlChars: siteChars } });
  const finished = await ctx.runMutation(internal.generate.finish, { ...build.result, ...site, summary: build.summary || "Your first website is ready.", onboardingId: id, attempt, clones: build.clones });
  if (finished === "cancelled") {
    await ctx.runMutation(internal.diagnostics.close, { runId, status: "failed", error: "Build cancelled" });
    return;
  }
  await ctx.runMutation(internal.diagnostics.close, {
    runId,
    status: "complete",
    htmlChars: siteChars,
    imageWanted,
    imageMade,
  });
}

export const build = internalAction({
  args: { id: v.id("siteOnboarding"), attempt: v.number() },
  handler: async (ctx, { id, attempt }): Promise<void> => {
    const row = await ctx.runQuery(internal.onboarding.load, { id });
    if (!row?.siteId || row.attempt !== attempt || row.status !== "queued") return;
    // One copy builds an attempt; any other stops here (see research).
    const lease = await ctx.runMutation(internal.onboarding.claimStep, { id, attempt, step: "build" });
    if (!lease) return;
    const stop = heartbeat(ctx, { id, attempt, lease });
    const deadline = Date.now() + TEXT_BUDGET_MS;
    // Everything from here on is inside the one catch, so whatever stops the
    // build -- the log as much as the model -- marks the attempt failed now
    // rather than leaving it queued for the watchdog to find.
    try {
      const route = chatRoute("build");
      let providerHost = route.baseUrl;
      try { providerHost = new URL(route.baseUrl).host; } catch { /* keep the raw base if it is not a URL */ }
      const existing = await ctx.runQuery(internal.diagnostics.findOpen, { onboardingId: id, attempt });
      const runId = existing ?? await ctx.runMutation(internal.diagnostics.open, {
        userId: row.userId,
        source: "onboarding",
        status: "started",
        siteId: row.siteId,
        onboardingId: id,
        attempt,
        requestKind: "generate",
      });
      await ctx.runMutation(internal.diagnostics.attach, {
        runId,
        siteId: row.siteId,
        onboardingId: id,
        attempt,
        requestKind: "generate",
        providerHost,
        providerModel: route.model,
        providerLabel: route.label,
        keySet: Boolean(route.apiKey),
          status: "started",
      });
      const trace = providerTrace(ctx, runId, row.userId);
      const answers = row.answers;
      const assets = await Promise.all(row.assets.map(async asset => ({ name: asset.name,
        url: await ctx.storage.getUrl(asset.storageId), text: asset.type.startsWith("text/") ? (await (await ctx.storage.get(asset.storageId))?.text())?.slice(0, 12000) : undefined })));
      const contents = briefFile(answers, answers === row.answers ? row.strategy ?? "" : "", assets);
      const storageId = await ctx.storage.store(new Blob([contents], { type: "text/markdown" }));
      // Read the persisted file, not a client prompt, as the agent's source.
      const file = await ctx.storage.get(storageId);
      if (!file) throw new Error("The build brief could not be read");
      const brief = await file.text();
      if (!await ctx.runMutation(internal.onboarding.checkpoint, { id, attempt, storageId, lease })) {
        await ctx.storage.delete(storageId);
        // Another copy holds the build: the attempt goes on, and so does its log.
        const latest = await ctx.runQuery(internal.onboarding.load, { id });
        if (latest?.attempt !== attempt || !isActiveBuild(latest.status)) {
          await ctx.runMutation(internal.diagnostics.close, { runId, status: "failed", error: "This build is no longer active" });
        }
        return;
      }
      // Past its checkpoint the attempt is building, and the watchdog speaks for it.
      stop();
      const epoch = await ctx.runQuery(internal.siteDesign.siteEpoch, { siteId: row.siteId });
      const savedDesign = await ctx.runQuery(internal.siteDesign.forSite, { siteId: row.siteId });
      if (!savedDesign || savedDesign.buildEpoch !== epoch || !isMeasured(savedDesign)) throw new Error(NOT_MEASURED);
      const designPrompt = savedDesign.prompt;
      await trace.note({ phase: "design_loaded", label: "Loaded the saved design reference" });
      const job = await ctx.runMutation(internal.generate.beginOnboarding, { id, attempt });
      await ctx.runMutation(internal.diagnostics.attach, {
        runId,
        messageId: job.result.assistantId,
        holdId: job.result.holdId,
        requestKind: job.result.requestKind,
        status: "calling",
      });
      await trace.note({
        phase: "held",
        label: "Credits held for a build",
        detail: { requestKind: job.result.requestKind, host: providerHost, model: route.model, keySet: Boolean(route.apiKey) },
      });
      const page = await writePage([...job.messages,
        { role: "system", content: designPrompt },
        { role: "system", content: BUILD_ORDER },
        // The identifier only keeps one rebuild's prompt from being byte-identical
        // to the last. What a rebuild owes the member is FORGE_MD's rule, not this.
        ...(row.discardedDesignHashes !== undefined ? [{ role: "system" as const,
          content: `This turn is a rebuild: the previous page, its versions, thread and assets are already deleted, so build from the saved answers alone rather than trying to recover any of it. Do not print this line or the identifier on the website.\nRebuild identifier: ${id}/${attempt}/${row.revision}` }] : []),
        { role: "user", content: `File: website-build-brief.md\n\n${brief}` },
      ], deadline, trace, row.discardedDesignHashes,
      row.discardedDesignHashes !== undefined ? { requireImages: Boolean(imageRoute().apiKey) } : undefined);
      const design = await ctx.runQuery(internal.siteDesign.forSite, { siteId: row.siteId });
      if (!design || design.buildEpoch !== epoch || !isMeasured(design)) throw new Error("The saved design reference disappeared during the build");
      assertDesignRules(page.site, design.referenceUrl);
      // The site is saved only once the layout check passes it
      // (designGate.ts), which finishes the build from there.
      await ctx.runMutation(internal.designGate.open, {
        source: "onboarding",
        runId,
        userId: row.userId,
        siteId: job.result.siteId,
        assistantId: job.result.assistantId,
        holdId: job.result.holdId,
        requestKind: job.result.requestKind,
        epoch: job.result.epoch,
        onboardingId: id,
        attempt,
        rebuild: row.discardedDesignHashes !== undefined,
        siteName: job.siteName,
        ...page.site,
        summary: page.summary,
      });
    } catch (error) {
      // What stopped the build is what the member reads, in the same words the
      // thread would use: a provider's answer, a clock that ran out, a balance.
      // `describe` has already scrubbed keys and cut it to a line.
      const reason = describe(error);
      console.error("Forge onboarding build failed:", reason);
      await ctx.runMutation(internal.onboarding.stepFailed, { id, attempt, step: "build", lease, reason });
    } finally {
      stop();
    }
  },
});

export const expire = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number(), failed: v.optional(v.boolean()), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.reason && !args.failed) {
      const row = await ctx.db.get(args.id);
      if (row?.attempt === args.attempt && isActiveBuild(row.status) && Date.now() - row.updatedAt < WATCHDOG_MS) {
        await ctx.scheduler.runAfter(Math.max(1000, WATCHDOG_MS - (Date.now() - row.updatedAt)),
          internal.onboarding.expire, { id: args.id, attempt: args.attempt });
        return;
      }
    }
    await stopAttempt(ctx, args);
  },
});

// Ends an attempt that is still running: its credits go back, and the member
// is told why in the words the thread would use. The design reviewer ends a
// build it never agreed to through here too.
export async function stopAttempt(
  ctx: MutationCtx,
  { id, attempt, failed, reason }: { id: Id<"siteOnboarding">; attempt: number; failed?: boolean; reason?: string },
) {
  const row = await ctx.db.get(id);
  if (!row || row.attempt !== attempt || !["queued", "building", "saving"].includes(row.status)) return;
  if (row.holdId) await releaseHold(ctx, row.holdId);
  const error = reason ? `${reason.replace(/[.!?]?\s*$/, ".")} Your answers are saved.`
    : failed ? "Your website couldn’t be completed. Your answers are saved. Try building again." : "The build stopped responding. Your answers are saved. Try building again.";
  if (row.assistantId && await ctx.db.get(row.assistantId)) await ctx.db.patch(row.assistantId, { status: "failed", body: error });
  await ctx.db.patch(id, { status: "failed", error, holdId: undefined, updatedAt: Date.now() });
  // No reason and no failure means the build never came back to say how it
  // ended: this is the watchdog, and the log gets its last sign of life.
  if (!reason && !failed) {
    const run = await ctx.db
      .query("buildRuns")
      .withIndex("by_onboarding_attempt", (q) => q.eq("onboardingId", id).eq("attempt", attempt))
      .first();
    if (run) await recordLastSign(ctx, run._id);
  }
  await failOpenRun(ctx, { onboardingId: id, attempt, error });
}
