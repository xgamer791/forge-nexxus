// A first build written a page at a time.
//
// A measured reference with more than one page is more site than one reply can
// write inside an action's ten minutes: a seven-page rebuild spent its whole
// clock thinking and never reached a page. So the build is written in steps,
// each an action of its own, and nothing a step writes is lost when it ends.
//
// - The first turn writes the shell and the home page. Every later turn writes
//   one page into that shell, and is handed the shell and the pages before it
//   as written and frozen.
// - A step keeps asking for pages while its clock allows (PAGE_STEP_MS) and
//   stops at a page boundary once too little is left to start another
//   (PAGE_FLOOR_MS). Each page is saved the moment its block closes.
// - A reply the step's clock stops while it is writing is kept as far as it
//   got, and the next step carries it on from that character.
// - The next step is queued the moment one ends. Nobody presses anything.
// - A step that finishes nothing goes again, a few times, and then the build
//   stops with what stopped it. A step whose action the platform lost stops
//   beating, and the rescue starts it again from the last saved page.
// - Once every measured page is written the site goes to the layout check
//   (designGate.ts) exactly as a one-reply build's would, in the transaction
//   that closes the draft, so it can never be handed on twice.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { elided } from "./designCheck";
import { openGate } from "./designGate";
import { classifyError, providerTrace, recordEvent } from "./diagnostics";
import { callProviderPart, chatRoute, describe, onboardingMessages, readDraftReply, ReplyStopped } from "./generate";
import { imageRoute } from "./images";
import {
  designHash, draftTurn, heartbeat, MOST_RESTARTS, PAGE_FLOOR_MS, PAGE_STEP_MS, rebuildNote, RESCUE_BATCH, STEP_QUIET_MS, stopAttempt,
} from "./onboarding";
import { composePage, designSource, siteParts, type SitePage } from "./pages";
import { assertDesignRules, auditDesign, isMeasured } from "./siteDesign";
import type { StreamStats } from "./stream";

// Steps in a row that may finish nothing -- no page, and nothing more of one --
// before the build stops with what stopped the last of them.
export const STEP_TRIES = 3;
// Steps that may carry one page on before it is a page that never ends.
export const MOST_RESUMES = 4;
// Steps a draft may take in all, per page: a ceiling no build that is getting
// anywhere comes near, so that none can go round forever.
const STEPS_PER_PAGE = 4;
const KEEP_DRAFTS = 20;

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const stopValidator = v.object({
  reason: v.string(),
  phase: v.string(),
  reasoningChars: v.optional(v.number()),
  replyChars: v.optional(v.number()),
});

type Draft = Doc<"buildDrafts">;

// The page a step writes next: one it has part-written first, then the home
// page with the shell, then the rest in the order they were measured. Null
// once every page is written.
export function nextPage(draft: Pick<Draft, "routes" | "pages" | "shell" | "partial">) {
  if (draft.partial) return draft.partial.path;
  if (!draft.shell) return "/";
  return draft.routes.find((path) => !draft.pages.some((page) => page.path === path)) ?? null;
}

// How the member's log names a page: its place in the site, and its address.
function place(draft: Pick<Draft, "routes">, path: string) {
  return `page ${draft.routes.indexOf(path) + 1} of ${draft.routes.length}`;
}
function pageName(path: string) {
  return path === "/" ? "home" : path;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// A reply that carries a block on, joined to where the block stopped. A fence
// the model opened anyway loses its line. One that started the block over from
// its first line replaces what was there rather than doubling it.
export function joinCarry(carried: string, more: string) {
  const rest = more.replace(/^\s*```html\b[^\n]*\r?\n/i, "");
  const opened = carried.lastIndexOf("```");
  const lineEnd = opened === -1 ? -1 : carried.indexOf("\n", opened);
  if (lineEnd !== -1) {
    const lead = (text: string) => text.replace(/\s+/g, "").slice(0, 60);
    const before = lead(carried.slice(lineEnd + 1));
    if (before.length === 60 && lead(rest) === before) return carried.slice(0, lineEnd + 1) + rest;
  }
  return carried + rest;
}

function shellFault(body: string, referenceUrl: string) {
  if (!/<html[\s>]/i.test(body) || !/<\/html>\s*$/i.test(body)) {
    return "the shell was missing its <html>, or stopped before </html>. Send back the whole shell, closed with its fence.";
  }
  const gap = elided(body);
  if (gap) return `the shell has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`;
  try {
    assertDesignRules({ html: body }, referenceUrl);
  } catch (error) {
    return describe(error);
  }
  return null;
}

function pageFault(page: SitePage, shell: string, referenceUrl: string, imagery: boolean) {
  if (!page.body.trim()) return "the page came back empty. Write the whole page.";
  const gap = elided(page.body);
  if (gap) return `the page has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`;
  try {
    assertDesignRules({ shell, pages: [page] }, referenceUrl);
  } catch (error) {
    return describe(error);
  }
  const tags = siteParts({ shell, pages: [page] }).join("\n").match(/<img\b[^>]*>/gi) ?? [];
  if (imagery && !tags.some((tag) => /\bdata-forge-image\s*=\s*["'][^"']+/i.test(tag))) {
    return "a rebuild needs new pictures, and this page asked for none. Ask for at least one with an img whose src is forge-image:1.";
  }
  return null;
}

export type Turn = {
  shell?: string;
  summary?: string;
  pages: SitePage[];
  // The block the reply was stopped inside, to be carried on by the next step.
  partial?: { path: string; text: string };
  // Why the page asked for could not be used, for the next turn to put right.
  problem?: string;
};

// What a turn's reply leaves to keep: the shell, on the first turn, if it
// closed whole and clean; every page still to write that closed whole and
// clean; and the block the reply was stopped inside, if it was stopped. A reply
// that ended on its own with its last fence still open finished that block and
// left the fence off, so it is read as closed.
export function readTurn(
  text: string,
  input: { draft: Pick<Draft, "routes" | "pages" | "shell">; target: string; cut: boolean; referenceUrl: string; imagery: boolean },
): Turn {
  const reply = readDraftReply(text);
  const { draft, target, cut } = input;
  const turn: Turn = { pages: [] };
  let shell = draft.shell;
  if (!shell && reply.shell && (reply.shell.closed || !cut)) {
    const fault = shellFault(reply.shell.body, input.referenceUrl);
    if (fault) turn.problem = fault;
    else {
      shell = turn.shell = reply.shell.body;
      turn.summary = reply.summary || undefined;
    }
  }
  const taken = new Set(draft.pages.map((page) => page.path));
  for (const page of reply.pages) {
    if (!page.path || !draft.routes.includes(page.path) || taken.has(page.path)) continue;
    if (!shell || (!page.closed && cut)) continue;
    const kept = { path: page.path, title: page.title, body: page.body };
    const fault = pageFault(kept, shell, input.referenceUrl, input.imagery && page.path === "/");
    if (fault) {
      if (page.path === target) turn.problem = fault;
      continue;
    }
    taken.add(page.path);
    turn.pages.push(kept);
  }
  if (cut && reply.open) {
    // Stopped inside the shell, the whole first reply goes on; stopped inside
    // a page still to write, that page's block does.
    if (!shell && reply.open.shell) turn.partial = { path: "/", text };
    else if (shell && reply.open.path && draft.routes.includes(reply.open.path) && !taken.has(reply.open.path)) {
      turn.partial = { path: reply.open.path, text: text.slice(reply.open.at) };
    }
  }
  if (!turn.problem && !turn.shell && !turn.pages.length && !turn.partial) {
    turn.problem = !shell
      ? "the reply had no whole shell in it. Send the shell in a ```html shell block that ends with </html>, then the home page."
      : `the reply had no page at ${target} in it. Send it in a \`\`\`html path="${target}" block.`;
  }
  return turn;
}

// Whether another step could get further. The stream stopping, a reply that
// fell short of a page and a connection that failed are worth another go; a
// provider that refused the request, or a deployment that is not set up, will
// only say the same thing again.
function retryable(error: unknown) {
  if (error instanceof ReplyStopped) return true;
  if (error instanceof ConvexError) return false;
  const status = describe(error).match(/answered (\d{3})/)?.[1];
  return !status || !status.startsWith("4") || status === "408" || status === "429";
}

// Where a reply that stopped short had got to, for the draft's log.
function stopOf(error: unknown) {
  if (error instanceof ReplyStopped) {
    const { stats } = error.stop;
    return { reason: error.stop.reason, phase: stats.phase, reasoningChars: stats.reasoningChars || undefined, replyChars: stats.contentChars || undefined };
  }
  return { reason: classifyError(describe(error)), phase: "none" };
}

function cutStop(reply: { outOfTime?: boolean; stats?: StreamStats; content: string }) {
  return {
    reason: reply.outOfTime ? "out_of_time" : reply.stats?.finishReason === "length" ? "length" : "dropped",
    phase: reply.stats?.phase ?? "writing",
    reasoningChars: reply.stats?.reasoningChars || undefined,
    replyChars: reply.content.length || undefined,
  };
}

function mostSteps(draft: Pick<Draft, "routes">) {
  return draft.routes.length * STEPS_PER_PAGE + 2;
}

async function close(ctx: MutationCtx, draft: Draft, status: "done" | "failed" | "cancelled", error?: string) {
  await ctx.db.patch(draft._id, {
    status,
    ...(error ? { error } : {}),
    shell: undefined,
    pages: [],
    partial: undefined,
    lease: undefined,
    updatedAt: Date.now(),
  });
}

// Ends the build a draft belongs to: its credits go back and the member is
// told why, in the words any failed build uses. `stalled` is a draft that
// went quiet rather than one that said what stopped it.
async function failDraft(ctx: MutationCtx, draft: Draft, reason?: string, stalled = false) {
  await close(ctx, draft, "failed", reason);
  await stopAttempt(ctx, { id: draft.onboardingId, attempt: draft.attempt, failed: !stalled, reason });
}

// Closes a draft its build no longer wants and says whether it did: the
// attempt moved on or stopped, its credits went back, the site was rebuilt or
// cancelled under it -- or the site now holds a design reference other than
// the one these pages were written against, which nothing can check them by.
async function settle(ctx: MutationCtx, draft: Draft) {
  const row = await ctx.db.get(draft.onboardingId);
  const hold = await ctx.db.get(draft.holdId);
  const site = await ctx.db.get(draft.siteId);
  const message = await ctx.db.get(draft.assistantId);
  if (!row || row.attempt !== draft.attempt || row.status !== "building" || hold?.status !== "held" ||
      !site || (site.buildEpoch ?? 0) !== draft.epoch || message?.status !== "pending") {
    await close(ctx, draft, "cancelled");
    return true;
  }
  const design = await ctx.db.query("siteDesignPackages").withIndex("by_site", (q) => q.eq("siteId", draft.siteId)).first();
  if (!design || design._id !== draft.designId || design.storageId !== draft.designStorageId ||
      design.buildEpoch !== draft.epoch || !isMeasured(design)) {
    await failDraft(ctx, draft, "The saved design reference disappeared during the build");
    return true;
  }
  return false;
}

// The attempt's own row hears that its build moved: that is what its watchdog
// reads, alongside the draft's own heartbeat.
async function touch(ctx: MutationCtx, onboardingId: Id<"siteOnboarding">) {
  if (await ctx.db.get(onboardingId)) await ctx.db.patch(onboardingId, { updatedAt: Date.now() });
}

async function prune(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("buildDrafts").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").collect();
  for (const row of rows.filter((row) => row.status !== "writing").slice(KEEP_DRAFTS - 1)) await ctx.db.delete(row._id);
}

// The build's hand-off, once its credits are held: the draft, and its first
// step queued straight away.
export const start = internalMutation({
  args: {
    onboardingId: v.id("siteOnboarding"),
    attempt: v.number(),
    runId: v.id("buildRuns"),
    siteId: v.id("sites"),
    assistantId: v.id("messages"),
    holdId: v.id("creditHolds"),
    epoch: v.number(),
    siteName: v.string(),
    rebuild: v.boolean(),
    designId: v.id("siteDesignPackages"),
    designStorageId: v.id("_storage"),
    model: v.string(),
    memory: v.optional(v.string()),
    routes: v.array(v.string()),
  },
  returns: v.union(v.id("buildDrafts"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.onboardingId);
    if (!row || row.attempt !== args.attempt || row.status !== "building" || row.holdId !== args.holdId) return null;
    const existing = await ctx.db
      .query("buildDrafts")
      .withIndex("by_onboarding_attempt", (q) => q.eq("onboardingId", args.onboardingId).eq("attempt", args.attempt))
      .first();
    if (existing) return existing._id;
    await prune(ctx, row.userId);
    const now = Date.now();
    const id = await ctx.db.insert("buildDrafts", {
      ...args,
      userId: row.userId,
      pages: [],
      step: 0,
      tries: 0,
      restarts: 0,
      beatAt: now,
      status: "writing",
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      runId: args.runId,
      userId: row.userId,
      phase: "draft_start",
      label: `Writing your ${args.routes.length} pages one at a time`,
      status: "calling",
      detail: { total: args.routes.length },
    });
    await ctx.scheduler.runAfter(0, internal.buildDraft.write, { id });
    return id;
  },
});

// The start of a step. One copy holds a draft at a time: another stops here,
// and so does any copy once the build no longer wants the draft.
export const claim = internalMutation({
  args: { id: v.id("buildDrafts") },
  handler: async (ctx, { id }): Promise<{ draft: Draft; lease: string } | null> => {
    const draft = await ctx.db.get(id);
    if (!draft || draft.status !== "writing") return null;
    const now = Date.now();
    if (draft.lease && now - draft.beatAt < STEP_QUIET_MS) return null;
    if (await settle(ctx, draft)) return null;
    if (draft.step >= mostSteps(draft)) {
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
        label: "Stopped before every page was written",
        detail: { step: draft.step, total: draft.routes.length },
      });
      await failDraft(ctx, draft);
      return null;
    }
    const lease = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const next = { lease, beatAt: now, step: draft.step + 1, updatedAt: now };
    await ctx.db.patch(id, next);
    await touch(ctx, draft.onboardingId);
    return { draft: { ...draft, ...next }, lease };
  },
});

// A sign of life from the copy that holds the draft.
export const beat = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, lease }) => {
    const draft = await ctx.db.get(id);
    if (!draft || draft.status !== "writing" || draft.lease !== lease) return false;
    await ctx.db.patch(id, { beatAt: Date.now() });
    return true;
  },
});

// What a step reads besides the draft: the brief every build is written from,
// the measured spec, the reference's address, and a rebuild's note.
export const setting = internalQuery({
  args: { id: v.id("buildDrafts") },
  handler: async (ctx, { id }) => {
    const draft = await ctx.db.get(id);
    if (!draft) return null;
    const row = await ctx.db.get(draft.onboardingId);
    const design = await ctx.db.get(draft.designId);
    if (!row?.briefStorageId || !design) return null;
    return {
      briefStorageId: row.briefStorageId,
      spec: design.prompt,
      referenceUrl: design.referenceUrl,
      rebuild: draft.rebuild ? rebuildNote(draft.onboardingId, draft.attempt, row.revision) : undefined,
    };
  },
});

// A checkpoint: the shell or pages a turn finished, saved the moment they
// closed. Anything saved is progress, so the step's misses start over. Null
// when the copy lost its hold or the build no longer wants the draft.
export const keep = internalMutation({
  args: {
    id: v.id("buildDrafts"),
    lease: v.string(),
    shell: v.optional(v.string()),
    summary: v.optional(v.string()),
    pages: v.array(pageValidator),
  },
  handler: async (ctx, args): Promise<Draft | null> => {
    const draft = await ctx.db.get(args.id);
    if (!draft || draft.status !== "writing" || draft.lease !== args.lease) return null;
    if (await settle(ctx, draft)) return null;
    const shell = draft.shell ?? args.shell;
    const pages = [...draft.pages];
    for (const page of shell ? args.pages : []) {
      if (draft.routes.includes(page.path) && !pages.some((kept) => kept.path === page.path)) pages.push(page);
    }
    // A carried page now written, or a first reply whose shell is now kept,
    // leaves nothing to carry on; what is still open is saved by `stepped`.
    const carried = draft.partial;
    const partial = carried && !pages.some((page) => page.path === carried.path) && !(args.shell && !draft.shell) ? carried : undefined;
    const now = Date.now();
    const next = {
      shell,
      pages,
      summary: draft.summary ?? args.summary,
      partial,
      tries: 0,
      restarts: 0,
      problem: undefined,
      beatAt: now,
      updatedAt: now,
    };
    await ctx.db.patch(args.id, next);
    await touch(ctx, draft.onboardingId);
    return { ...draft, ...next };
  },
});

// The end of a step, and the next one queued. A step ends at a page boundary
// once its clock is short, with a page cut part way and saved to carry on, or
// with nothing to show -- which the next step tries again, until the misses
// run out and the build stops with what stopped the last of them.
export const stepped = internalMutation({
  args: {
    id: v.id("buildDrafts"),
    lease: v.string(),
    outcome: v.union(v.literal("boundary"), v.literal("partial"), v.literal("nothing")),
    partial: v.optional(v.object({ path: v.string(), text: v.string() })),
    // What stopped a step that finished nothing, in the member's words.
    reason: v.optional(v.string()),
    // Why a reply could not be used, in the model's.
    problem: v.optional(v.string()),
    stop: v.optional(stopValidator),
    // False when the clock ran out on a page started late in its step,
    // which is no fair go at the page.
    counts: v.optional(v.boolean()),
    // Nothing another step could change: the build stops now.
    fatal: v.optional(v.boolean()),
  },
  returns: v.union(v.literal("next"), v.literal("failed"), v.literal("gone")),
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.id);
    if (!draft || draft.status !== "writing" || draft.lease !== args.lease) return "gone";
    if (await settle(ctx, draft)) return "gone";
    const now = Date.now();
    const lastStop = args.stop ? { ...args.stop, at: now } : draft.lastStop;
    const patch: Partial<Draft> = { lease: undefined, beatAt: now, updatedAt: now, lastStop };
    const target = nextPage(draft) ?? "/";
    const detail = { path: target, page: draft.routes.indexOf(target) + 1, total: draft.routes.length, step: draft.step };
    if (args.outcome === "nothing") {
      const tries = draft.tries + (args.counts === false ? 0 : 1);
      if (args.fatal || tries >= STEP_TRIES) {
        await ctx.db.patch(args.id, { ...patch, tries });
        await recordEvent(ctx, {
          runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
          label: `Stopped at ${place(draft, target)}: ${pageName(target)}`,
          detail: { ...detail, errorClass: classifyError(args.reason ?? ""), stopReason: args.stop?.reason, streamPhase: args.stop?.phase },
        });
        await failDraft(ctx, { ...draft, ...patch, tries }, args.reason ?? "The agent did not return a website");
        return "failed";
      }
      Object.assign(patch, { tries, problem: args.problem });
    } else if (args.outcome === "partial" && args.partial) {
      const resumes = draft.partial?.path === args.partial.path ? draft.partial.resumes + 1 : 1;
      if (resumes > MOST_RESUMES) {
        await ctx.db.patch(args.id, patch);
        await recordEvent(ctx, {
          runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
          label: `Stopped at ${place(draft, args.partial.path)}: it kept stopping part way`,
          detail: { ...detail, path: args.partial.path, continuation: resumes },
        });
        await failDraft(ctx, { ...draft, ...patch });
        return "failed";
      }
      Object.assign(patch, { partial: { ...args.partial, resumes }, tries: 0, problem: undefined });
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_partial",
        label: `Saved ${place(draft, args.partial.path)} as far as it got: ${pageName(args.partial.path)}`,
        status: "calling",
        detail: {
          path: args.partial.path, page: draft.routes.indexOf(args.partial.path) + 1, total: draft.routes.length, step: draft.step,
          continuation: resumes, replyChars: args.partial.text.length, stopReason: args.stop?.reason, streamPhase: args.stop?.phase,
          reasoningChars: args.stop?.reasoningChars,
        },
      });
    } else {
      Object.assign(patch, { tries: 0, problem: undefined });
    }
    await ctx.db.patch(args.id, patch);
    await touch(ctx, draft.onboardingId);
    await ctx.scheduler.runAfter(0, internal.buildDraft.write, { id: args.id });
    return "next";
  },
});

// Every page is written: the site goes to the layout check, in the same
// transaction that closes the draft. It passes the checks a one-reply build
// passes on its way there -- the design rules across the whole site, and on a
// rebuild, not the design that was thrown away.
export const handOff = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string() },
  returns: v.union(v.literal("gate"), v.literal("failed"), v.literal("gone")),
  handler: async (ctx, { id, lease }) => {
    const draft = await ctx.db.get(id);
    if (!draft || draft.status !== "writing" || draft.lease !== lease) return "gone";
    if (await settle(ctx, draft)) return "gone";
    const pages = draft.routes.flatMap((path) => draft.pages.filter((page) => page.path === path));
    if (!draft.shell || pages.length !== draft.routes.length) return "gone";
    const site = { shell: draft.shell, pages };
    const row = (await ctx.db.get(draft.onboardingId))!;
    const design = (await ctx.db.get(draft.designId))!;
    let fault: string | undefined;
    try {
      assertDesignRules(site, design.referenceUrl);
    } catch (error) {
      fault = describe(error);
    }
    if (!fault && row.discardedDesignHashes?.includes(await designHash(designSource(site)))) {
      fault = "The model repeated the discarded design. Rebuild again to request a new one.";
    }
    if (fault) {
      await failDraft(ctx, draft, fault);
      return "failed";
    }
    await recordEvent(ctx, {
      runId: draft.runId, userId: draft.userId, phase: "draft_done",
      label: `Wrote all ${draft.routes.length} pages`,
      status: "calling",
      detail: { total: draft.routes.length, step: draft.step, htmlChars: siteParts(site).join("").length },
    });
    await openGate(ctx, {
      source: "onboarding",
      runId: draft.runId,
      userId: draft.userId,
      siteId: draft.siteId,
      assistantId: draft.assistantId,
      holdId: draft.holdId,
      requestKind: "generate",
      epoch: draft.epoch,
      onboardingId: draft.onboardingId,
      attempt: draft.attempt,
      rebuild: draft.rebuild,
      siteName: draft.siteName,
      shell: site.shell,
      pages: site.pages,
      summary: draft.summary ?? "",
    });
    await close(ctx, draft, "done");
    return "gate";
  },
});

// One step: pages while the clock allows, each saved as it closes, then the
// next step queued. `budgetMs` shortens this one step's clock, for tests; the
// chain itself never passes it.
export const write = internalAction({
  args: { id: v.id("buildDrafts"), budgetMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, budgetMs }): Promise<null> => {
    const claimed = await ctx.runMutation(internal.buildDraft.claim, { id });
    if (!claimed) return null;
    const { lease } = claimed;
    let draft = claimed.draft;
    const deadline = Date.now() + Math.min(Math.max(budgetMs ?? PAGE_STEP_MS, 1000), PAGE_STEP_MS);
    const stopBeating = heartbeat(() => ctx.runMutation(internal.buildDraft.beat, { id, lease }));
    const trace = providerTrace(ctx, draft.runId, draft.userId);
    try {
      const setting = await ctx.runQuery(internal.buildDraft.setting, { id });
      const brief = setting ? await (await ctx.storage.get(setting.briefStorageId))?.text() : undefined;
      if (!setting || !brief) {
        await ctx.runMutation(internal.buildDraft.stepped, { id, lease, outcome: "nothing", reason: "The build brief could not be read", fatal: true });
        return null;
      }
      const base = onboardingMessages(draft.siteName, draft.memory ?? null);
      const model = chatRoute("build").model;
      const imagery = draft.rebuild && Boolean(imageRoute().apiKey);
      let problem = draft.problem;
      let wrote = 0;
      for (;;) {
        const target = nextPage(draft);
        if (target === null) {
          await ctx.runMutation(internal.buildDraft.handOff, { id, lease });
          return null;
        }
        // The clock is short: the step ends at this page boundary, and the
        // next step starts the page with a whole clock of its own.
        if (wrote > 0 && deadline - Date.now() < PAGE_FLOOR_MS) {
          await ctx.runMutation(internal.buildDraft.stepped, { id, lease, outcome: "boundary" });
          return null;
        }
        // A reply another model began is written again rather than carried on.
        const carry = draft.partial && draft.model === model ? draft.partial : undefined;
        const where = place(draft, target);
        const detail = { path: target, page: draft.routes.indexOf(target) + 1, total: draft.routes.length, step: draft.step };
        const again = draft.tries > 0 || Boolean(problem);
        await trace.note({
          phase: carry ? "draft_resume" : "draft_page",
          label: carry
            ? `Carrying on ${where} from where it stopped: ${pageName(target)}`
            : `Writing ${where}${again ? " again" : ""}: ${draft.shell ? pageName(target) : "home, with the header, menu and footer"}`,
          status: "calling",
          detail: carry ? { ...detail, continuation: carry.resumes, replyChars: carry.text.length } : detail,
        });
        const messages = draftTurn({
          base,
          spec: setting.spec,
          routes: draft.routes,
          siteName: draft.siteName,
          brief,
          target,
          rebuild: setting.rebuild,
          imagery,
          written: draft.shell ? { summary: draft.summary, shell: draft.shell, pages: draft.pages } : undefined,
          problem,
          carry: carry?.text,
        });
        let reply: Awaited<ReturnType<typeof callProviderPart>>;
        try {
          reply = await callProviderPart(messages, deadline - Date.now(), trace, Boolean(carry));
        } catch (error) {
          // The clock running out on a page started late in the step is no
          // fair go at it: the next step starts it with a whole clock. Any
          // other miss counts.
          const late = wrote > 0 && error instanceof ReplyStopped && error.stop.reason === "out_of_time";
          await ctx.runMutation(internal.buildDraft.stepped, {
            id, lease, outcome: "nothing", reason: describe(error), stop: stopOf(error), counts: !late, fatal: !retryable(error),
          });
          return null;
        }
        const text = carry ? joinCarry(carry.text, reply.content) : reply.content;
        const turn = readTurn(text, { draft, target, cut: reply.cut, referenceUrl: setting.referenceUrl, imagery });
        // A page is not kept until the auditors agree it matches the SkillUI
        // extract. One page at a time. A miss is the next turn's problem.
        if (turn.pages.length) {
          const shell = turn.shell ?? draft.shell;
          const accepted: SitePage[] = [];
          for (const page of turn.pages) {
            const html = shell ? composePage({ shell, pages: [...draft.pages, ...accepted, page] }, page.path) : null;
            if (!html) {
              turn.problem = `the page at ${page.path} could not be assembled for the auditors.`;
              continue;
            }
            try {
              const outcome = await auditDesign(ctx, { storageId: draft.designStorageId, pages: [{ path: page.path, html }] }, trace, draft.step);
              if (!outcome.passed) {
                turn.problem = outcome.fixes[0] ?? `the auditors did not agree that ${page.path} matches the SkillUI Ultra extract.`;
                continue;
              }
            } catch (error) {
              turn.problem = `the auditors could not check ${page.path}: ${describe(error)}`;
              continue;
            }
            accepted.push(page);
          }
          turn.pages = accepted;
        }
        if (turn.shell || turn.pages.length) {
          const kept = await ctx.runMutation(internal.buildDraft.keep, { id, lease, shell: turn.shell, summary: turn.summary, pages: turn.pages });
          if (!kept) return null;
          if (turn.shell) {
            await trace.note({ phase: "draft_page_done", label: "Wrote the header, menu and footer", status: "calling", detail: { ...detail, path: "/", replyChars: turn.shell.length } });
          }
          for (const page of turn.pages) {
            await trace.note({
              phase: "draft_page_done",
              label: `Wrote ${place(kept, page.path)}: ${pageName(page.path)}`,
              status: "calling",
              detail: { ...detail, path: page.path, page: kept.routes.indexOf(page.path) + 1, replyChars: page.body.length },
            });
          }
          draft = kept;
          wrote += turn.pages.length + (turn.shell ? 1 : 0);
          // The page asked for may still be to write; if so, what was wrong
          // with it goes with the next ask.
          problem = turn.problem;
          // Auditors refused the page just asked for. It is not complete, even
          // when the shell was worth keeping. The next step is told why.
          if (problem && !turn.pages.some((page) => page.path === target)) {
            await ctx.runMutation(internal.buildDraft.stepped, {
              id, lease, outcome: "nothing", reason: "The auditors did not agree", problem,
            });
            return null;
          }
        }
        if (turn.partial) {
          await ctx.runMutation(internal.buildDraft.stepped, { id, lease, outcome: "partial", partial: turn.partial, stop: cutStop(reply) });
          return null;
        }
        if (!turn.shell && !turn.pages.length) {
          // The member's log says what was wrong; the rest of the problem is
          // the model's instruction for its next go.
          await trace.note({
            phase: "draft_unusable",
            label: `${capital(where)} could not be used: ${turn.problem?.split(/(?<=\.)\s/)[0]}`,
            level: "warn",
            status: "calling",
            detail: { ...detail, replyChars: reply.content.length },
          });
          await ctx.runMutation(internal.buildDraft.stepped, {
            id, lease, outcome: "nothing", reason: "The agent did not return a website", problem: turn.problem,
          });
          return null;
        }
      }
    } catch (error) {
      // Whatever else stopped the step, the next one starts from what was
      // saved; if even that cannot be queued, the rescue starts it.
      console.error("Forge page step failed:", describe(error));
      try {
        await ctx.runMutation(internal.buildDraft.stepped, { id, lease, outcome: "nothing", reason: describe(error) });
      } catch {
        /* The draft stops beating, and the rescue starts it again. */
      }
      return null;
    } finally {
      stopBeating();
    }
  },
});

// Every half minute (crons.ts). A draft whose step has gone quiet lost its
// action -- the platform stopped it, or dropped the step queued after it -- so
// the step is started again from the last saved page. A draft that keeps going
// quiet without getting anywhere stops, and its credits go back.
export const rescue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const quiet = await ctx.db
      .query("buildDrafts")
      .withIndex("by_status_beat", (q) => q.eq("status", "writing").lt("beatAt", now - STEP_QUIET_MS))
      .take(RESCUE_BATCH);
    for (const draft of quiet) {
      if (await settle(ctx, draft)) continue;
      const target = nextPage(draft);
      // Every page written and not yet handed on: what went quiet is the build.
      const where = target ? place(draft, target) : "the build";
      const detail = { ...(target ? { path: target, page: draft.routes.indexOf(target) + 1 } : {}), total: draft.routes.length, step: draft.step };
      if (draft.restarts >= MOST_RESTARTS) {
        await recordEvent(ctx, {
          runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
          label: `${capital(where)} went quiet again after ${draft.restarts} restarts, so the build stopped`,
          detail,
        });
        await failDraft(ctx, draft, undefined, true);
        continue;
      }
      await ctx.db.patch(draft._id, { lease: undefined, beatAt: now, restarts: draft.restarts + 1, updatedAt: now });
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_rescued", level: "warn",
        label: `Started ${where} again: nothing had been heard from it for ${Math.round((now - draft.beatAt) / 1000)}s`,
        status: "calling",
        detail,
      });
      await touch(ctx, draft.onboardingId);
      await ctx.scheduler.runAfter(0, internal.buildDraft.write, { id: draft._id });
    }
    return null;
  },
});

// Where recent drafts got to, for whoever runs the deployment:
// `npx convex run buildDraft:inspect`. Addresses and counts only, never a page.
export const inspect = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("buildDrafts").order("desc").take(KEEP_DRAFTS);
    return rows.map((row) => {
      const written = row.status === "done" ? row.routes : row.pages.map((page) => page.path);
      return {
        id: row._id,
        siteName: row.siteName,
        attempt: row.attempt,
        status: row.status,
        model: row.model,
        routes: row.routes,
        shell: row.status === "done" || Boolean(row.shell),
        written,
        remaining: row.routes.filter((path) => !written.includes(path)),
        partial: row.partial ? { path: row.partial.path, chars: row.partial.text.length, resumes: row.partial.resumes } : null,
        step: row.step,
        tries: row.tries,
        restarts: row.restarts,
        lastStop: row.lastStop ?? null,
        error: row.error ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  },
});
