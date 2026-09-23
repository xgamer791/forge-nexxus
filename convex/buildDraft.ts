// A first build or a rebuild, written a page at a time by a crew.
//
// The design worker's page discovery agent chose the pages -- five at most --
// and SkillUI Ultra extracted the reference's design (siteDesign.ts). Each page
// is then written by a crew of its own (crew.ts): one builder and one auditor
// for the header, two of each for the body, one of each for the footer. The
// builders work side by side, and each auditor reads its builder's part the
// moment it is saved and either agrees it matches the reference or sends it
// back with fixes. A page is kept only once all four of its auditors agree,
// and the next page's crew starts only then.
//
// - Every part is saved here the moment its builder writes it and again when
//   its auditor answers, so nothing a step does is lost when it ends.
// - A step is an action of its own. It works the crew while its clock allows
//   (PAGE_STEP_MS), starts another page only while enough of it is left
//   (PAGE_FLOOR_MS), and queues the next step the moment it ends. Nobody
//   presses anything.
// - A reply the step's clock stops while it is writing is kept as far as it
//   got, and the next step carries it on from that character.
// - The rest of the page is written once the top of it is, and carries on
//   from where the top ends.
// - A step that finishes nothing goes again, a few times, and then the build
//   stops with what stopped it. So does a part its auditor still does not
//   agree to after PART_REWORKS rounds, and a part whose replies keep coming
//   back unusable. Nothing is saved and the credits go back.
// - A step whose action the platform lost stops beating, and the rescue starts
//   it again from the last saved part.
// - Once every page is kept the site lands (designGate.ts, `audited`) in the
//   transaction that closes the draft, so it can never be handed on twice.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import {
  auditorTurn,
  builderTurn,
  crewWork,
  isChrome,
  newCrew,
  nextFor,
  pageFrom,
  PART_AGENTS,
  PART_NAMES,
  PART_REWORKS,
  partBlock,
  partOf,
  PARTS,
  readAudit,
  readPart,
  shellFrom,
  type CrewPart,
  type PartName,
} from "./crew";
import { openGate } from "./designGate";
import { classifyError, providerTrace, recordEvent, type EventDetail, type ProviderTrace } from "./diagnostics";
import { callProvider, callProviderPart, chatRoute, describe, onboardingMessages, ReplyStopped } from "./generate";
import { imageRoute } from "./images";
import {
  designHash, heartbeat, MOST_RESTARTS, NEW_IMAGERY, PAGE_FLOOR_MS, PAGE_STEP_MS, rebuildNote, RESCUE_BATCH, STEP_QUIET_MS, stopAttempt,
} from "./onboarding";
import { designSource, pagePlan, siteParts } from "./pages";
import { assertDesignRules, isSkillUI } from "./siteDesign";
import type { StreamStats } from "./stream";

// Steps in a row that may finish nothing -- no part, and nothing more of one --
// before the build stops with what stopped the last of them. A part's replies
// in a row that come back with nothing to use are held to the same number.
export const STEP_TRIES = 3;
// Steps that may carry one part on before it is a part that never ends.
export const MOST_RESUMES = 4;
// Steps a draft may take in all, per page: a ceiling no build that is getting
// anywhere comes near, so that none can go round forever.
const STEPS_PER_PAGE = 4;
const KEEP_DRAFTS = 20;
// A builder is only started with this much of the step's clock left, and an
// auditor with this much. Less, and the part waits for the next step, which
// starts it with a whole clock.
const BUILD_FLOOR_MS = 120000;
const AUDIT_FLOOR_MS = 60000;

const partValidator = v.union(v.literal("header"), v.literal("body1"), v.literal("body2"), v.literal("footer"));
const stopValidator = v.object({
  reason: v.string(),
  phase: v.string(),
  reasoningChars: v.optional(v.number()),
  replyChars: v.optional(v.number()),
});

type Draft = Doc<"buildDrafts">;
type Stop = { reason: string; phase: string; reasoningChars?: number; replyChars?: number };

// The page a step works on: the home page first, which writes the shell with
// it, then the rest in the order they were discovered. Null once every page
// is kept.
export function nextPage(draft: Pick<Draft, "routes" | "pages" | "shell">) {
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
const firstSentence = (text: string | undefined) => text?.split(/(?<=\.)\s/)[0] ?? "";

// A page as the member knows it.
function pageLabel(path: string) {
  return path === "/" ? "the home page" : `the ${path} page`;
}

// What the member reads when a part's auditor never agrees.
function outOfRounds(name: PartName, path: string) {
  return `The ${PART_NAMES[name]} of ${pageLabel(path)} still didn't match the design reference after three rounds of changes, so this build wasn't saved and your credits were returned. Try again.`;
}

// What the thread says once the site lands.
function builtSummary(count: number) {
  return count === 1
    ? "Built your one-page website. It matched the design reference before it was kept."
    : `Built your ${count}-page website. Every page matched the design reference before it was kept.`;
}

// Whether another go could get further. The stream stopping, a reply that
// fell short and a connection that failed are worth another go; a provider
// that refused the request, or a deployment that is not set up, will only say
// the same thing again.
function retryable(error: unknown) {
  if (error instanceof ReplyStopped) return true;
  if (error instanceof ConvexError) return false;
  const status = describe(error).match(/answered (\d{3})/)?.[1];
  return !status || !status.startsWith("4") || status === "408" || status === "429";
}

// Where a reply that stopped short had got to, for the draft's log.
function stopOf(error: unknown): Stop {
  if (error instanceof ReplyStopped) {
    const { stats } = error.stop;
    return { reason: error.stop.reason, phase: stats.phase, reasoningChars: stats.reasoningChars || undefined, replyChars: stats.contentChars || undefined };
  }
  return { reason: classifyError(describe(error)), phase: "none" };
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
    crew: undefined,
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
// cancelled under it -- or the site now holds a design package other than the
// SkillUI Ultra one these pages were written and audited against.
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
      design.buildEpoch !== draft.epoch || !isSkillUI(design)) {
    await failDraft(ctx, draft, "The saved design reference disappeared during the build");
    return true;
  }
  return false;
}

// The draft, for the copy that holds it, while its build still wants it.
async function live(ctx: MutationCtx, id: Id<"buildDrafts">, lease: string) {
  const draft = await ctx.db.get(id);
  if (!draft || draft.status !== "writing" || draft.lease !== lease) return null;
  if (await settle(ctx, draft)) return null;
  return draft;
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

// A part as it is stored: nothing unset rides along inside the crew.
function stored(part: CrewPart): CrewPart {
  return Object.fromEntries(Object.entries(part).filter(([, value]) => value !== undefined)) as CrewPart;
}

// One part changed. Anything saved is progress, so the step's misses and the
// rescue's restarts start over.
async function savePart(ctx: MutationCtx, draft: Draft, part: CrewPart, progress: boolean) {
  const crew = { ...draft.crew!, parts: draft.crew!.parts.map((each) => (each.name === part.name ? stored(part) : each)) };
  const now = Date.now();
  await ctx.db.patch(draft._id, { crew, ...(progress ? { tries: 0, restarts: 0 } : {}), beatAt: now, updatedAt: now });
  await touch(ctx, draft.onboardingId);
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
    // Five pages at most, the home page first, whatever the package held.
    const routes = pagePlan(args.routes);
    const now = Date.now();
    const id = await ctx.db.insert("buildDrafts", {
      ...args,
      routes,
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
      label: routes.length === 1
        ? "Writing your page with its own builders and auditors"
        : `Writing your ${routes.length} pages one at a time, each with its own builders and auditors`,
      status: "calling",
      detail: { total: routes.length },
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
// the SkillUI Ultra extract and its foundation stylesheet, the reference's
// address, and a rebuild's note.
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
      extract: design.prompt,
      foundation: design.foundation,
      referenceUrl: design.referenceUrl,
      rebuild: draft.rebuild ? rebuildNote(draft.onboardingId, draft.attempt, row.revision) : undefined,
    };
  },
});

// A page's crew, mustered: every part waiting on its builder, or -- for the
// shared header and footer on a page after the home page -- on its auditor.
export const muster = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string(), path: v.string() },
  handler: async (ctx, { id, lease, path }): Promise<Draft | null> => {
    const draft = await live(ctx, id, lease);
    if (!draft) return null;
    if (draft.crew?.path === path) return draft;
    if (!draft.routes.includes(path) || draft.pages.some((page) => page.path === path)) return null;
    const crew = newCrew(path, Boolean(draft.shell));
    const now = Date.now();
    await ctx.db.patch(id, { crew, beatAt: now, updatedAt: now });
    await touch(ctx, draft.onboardingId);
    return { ...draft, crew, beatAt: now, updatedAt: now };
  },
});

// A builder's part, saved the moment it is written. What its auditor asked for
// moves to `asked`, for the auditor to check next.
export const partBuilt = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string(), part: partValidator, markup: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, args): Promise<CrewPart | null> => {
    const draft = await live(ctx, args.id, args.lease);
    if (!draft?.crew) return null;
    const before = partOf(draft.crew, args.part);
    if (before.agreed) return null;
    const part: CrewPart = {
      ...before,
      markup: args.markup,
      title: args.title ?? before.title,
      asked: before.fixes.length ? before.fixes : before.asked,
      fixes: [],
      tries: 0,
      problem: undefined,
      partial: undefined,
      resumes: undefined,
    };
    await savePart(ctx, draft, part, true);
    return stored(part);
  },
});

// A builder's reply the step's clock stopped while it was writing -- or one a
// stream stopped once the part had begun -- saved as far as it got, from the
// part's opening fence: the next step carries it on from that character. A
// part saved part way more than MOST_RESUMES times is one that never ends,
// and the build stops.
export const partCarried = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string(), part: partValidator, text: v.string(), stop: v.optional(stopValidator) },
  handler: async (ctx, args): Promise<{ state: "saved" | "failed" | "gone"; part?: CrewPart }> => {
    const draft = await live(ctx, args.id, args.lease);
    if (!draft?.crew) return { state: "gone" };
    const before = partOf(draft.crew, args.part);
    if (before.agreed) return { state: "gone" };
    const path = draft.crew.path;
    const detail = { path, page: draft.routes.indexOf(path) + 1, total: draft.routes.length, step: draft.step, part: args.part };
    const resumes = before.partial !== undefined ? (before.resumes ?? 0) + 1 : 1;
    const now = Date.now();
    const lastStop = args.stop ? { ...args.stop, at: now } : draft.lastStop;
    if (resumes > MOST_RESUMES) {
      await ctx.db.patch(draft._id, { lastStop, updatedAt: now });
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
        label: `Stopped at ${place(draft, path)}: the ${PART_NAMES[args.part]} kept stopping part way`,
        detail: { ...detail, continuation: resumes },
      });
      await failDraft(ctx, { ...draft, lastStop });
      return { state: "failed" };
    }
    const part: CrewPart = { ...before, partial: args.text, resumes, tries: 0, problem: undefined };
    const crew = { ...draft.crew, parts: draft.crew.parts.map((each) => (each.name === part.name ? stored(part) : each)) };
    await ctx.db.patch(draft._id, { crew, tries: 0, lastStop, beatAt: now, updatedAt: now });
    await recordEvent(ctx, {
      runId: draft.runId, userId: draft.userId, phase: "draft_partial",
      label: `Saved the ${PART_NAMES[args.part]} of ${place(draft, path)} as far as it got: ${pageName(path)}`,
      status: "calling",
      detail: {
        ...detail, continuation: resumes, replyChars: args.text.length, stopReason: args.stop?.reason, streamPhase: args.stop?.phase,
        reasoningChars: args.stop?.reasoningChars,
      },
    });
    await touch(ctx, draft.onboardingId);
    return { state: "saved", part: stored(part) };
  },
});

// A reply for a part that could not be used: the builder's, with what was
// wrong with it for its next go, or the auditor's. A few in a row, or one
// that nothing will change, and the build stops. A builder's reply that could
// not be used takes any reply it was carrying on with it, and the next go
// starts the part afresh; one that failed leaves it to carry on.
export const partMissed = internalMutation({
  args: {
    id: v.id("buildDrafts"),
    lease: v.string(),
    part: partValidator,
    // What the member reads if this ends the build.
    reason: v.string(),
    // Why the builder's reply could not be used, in the model's words.
    problem: v.optional(v.string()),
    fatal: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ state: "again" | "failed" | "gone"; part?: CrewPart }> => {
    const draft = await live(ctx, args.id, args.lease);
    if (!draft?.crew) return { state: "gone" };
    const before = partOf(draft.crew, args.part);
    const tries = before.tries + 1;
    if (args.fatal || tries >= STEP_TRIES) {
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_failed", level: "error",
        label: `Stopped at ${place(draft, draft.crew.path)}: the ${PART_NAMES[args.part]} came back unusable ${tries === 1 ? "once" : `${tries} times in a row`}`,
        detail: { path: draft.crew.path, page: draft.routes.indexOf(draft.crew.path) + 1, total: draft.routes.length, step: draft.step, part: args.part, errorClass: classifyError(args.reason) },
      });
      await failDraft(ctx, draft, args.reason);
      return { state: "failed" };
    }
    const part: CrewPart = {
      ...before,
      tries,
      problem: args.problem ?? before.problem,
      ...(args.problem ? { partial: undefined, resumes: undefined } : {}),
    };
    await savePart(ctx, draft, part, false);
    return { state: "again", part: stored(part) };
  },
});

// An auditor's verdict on a part. Agreed, the part is done; sent back, its
// builder gets the fixes; sent back once too often, the build stops.
export const partAudited = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string(), part: partValidator, agree: v.boolean(), fixes: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ state: "agreed" | "rework" | "exhausted" | "gone"; part?: CrewPart }> => {
    const draft = await live(ctx, args.id, args.lease);
    if (!draft?.crew) return { state: "gone" };
    const before = partOf(draft.crew, args.part);
    if (before.agreed || before.markup === undefined) return { state: "gone" };
    const round = before.round + 1;
    if (args.agree) {
      const part: CrewPart = { ...before, round, agreed: true, fixes: [], asked: undefined, tries: 0, problem: undefined };
      await savePart(ctx, draft, part, true);
      return { state: "agreed", part: stored(part) };
    }
    if (round > PART_REWORKS) {
      const where = place(draft, draft.crew.path);
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "crew_exhausted", level: "error",
        label: `Stopped at ${where}: the auditor still didn't agree on the ${PART_NAMES[args.part]} after ${PART_REWORKS} rounds of changes`,
        status: "reviewing",
        detail: { path: draft.crew.path, page: draft.routes.indexOf(draft.crew.path) + 1, total: draft.routes.length, step: draft.step, part: args.part, round, agree: false },
      });
      await failDraft(ctx, draft, outOfRounds(args.part, draft.crew.path));
      return { state: "exhausted" };
    }
    const part: CrewPart = { ...before, round, fixes: args.fixes.slice(0, 40), asked: undefined, tries: 0, problem: undefined };
    await savePart(ctx, draft, part, true);
    return { state: "rework", part: stored(part) };
  },
});

// Every auditor on the page agreed: the page is kept, and on the home page the
// shell is put together from its header and footer. The next page's crew
// starts from here.
export const pageDone = internalMutation({
  args: { id: v.id("buildDrafts"), lease: v.string() },
  handler: async (ctx, { id, lease }): Promise<Draft | null> => {
    const draft = await live(ctx, id, lease);
    if (!draft?.crew || !draft.crew.parts.every((part) => part.agreed)) return null;
    const crew = draft.crew;
    const design = await ctx.db.get(draft.designId);
    const chromeInShell = !draft.shell;
    const shell = draft.shell ?? shellFrom({
      foundation: design?.foundation,
      header: partOf(crew, "header").markup ?? "",
      footer: partOf(crew, "footer").markup ?? "",
      siteName: draft.siteName,
    });
    const page = pageFrom(crew, { siteName: draft.siteName, chromeInShell });
    const pages = [...draft.pages.filter((kept) => kept.path !== page.path), page];
    const now = Date.now();
    const next = { shell, pages, crew: undefined, tries: 0, restarts: 0, beatAt: now, updatedAt: now };
    await ctx.db.patch(id, next);
    await recordEvent(ctx, {
      runId: draft.runId, userId: draft.userId, phase: "crew_page_done",
      label: `Kept ${place(draft, crew.path)}, ${pageName(crew.path)}: all four auditors agreed it matches the reference`,
      status: "calling",
      detail: { path: crew.path, page: draft.routes.indexOf(crew.path) + 1, total: draft.routes.length, step: draft.step, htmlChars: page.body.length + (chromeInShell ? shell.length : 0) },
    });
    await touch(ctx, draft.onboardingId);
    return { ...draft, ...next };
  },
});

// The end of a step, and the next one queued. A step ends at a page boundary
// once its clock is short, with what its crew saved -- a part cut part way
// among it, to carry on -- or with nothing to show, which the next step tries
// again, until the misses run out and the build stops with what stopped the
// last of them.
export const stepped = internalMutation({
  args: {
    id: v.id("buildDrafts"),
    lease: v.string(),
    outcome: v.union(v.literal("boundary"), v.literal("nothing")),
    // What stopped a step that finished nothing, in the member's words.
    reason: v.optional(v.string()),
    stop: v.optional(stopValidator),
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
      const tries = draft.tries + 1;
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
      Object.assign(patch, { tries });
    } else {
      Object.assign(patch, { tries: 0 });
    }
    await ctx.db.patch(args.id, patch);
    await touch(ctx, draft.onboardingId);
    await ctx.scheduler.runAfter(0, internal.buildDraft.write, { id: args.id });
    return "next";
  },
});

// Every page is kept: the site lands, in the same transaction that closes the
// draft. It passes the checks a site passes on its way to being saved -- the
// design rules across the whole site, and on a rebuild, not the design that
// was thrown away -- and needs no further audit: each of its pages already
// has its auditors' agreement.
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
      label: draft.routes.length === 1 ? "Wrote your page, and every auditor agreed" : `Wrote all ${draft.routes.length} pages, and every auditor agreed`,
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
      summary: builtSummary(site.pages.length),
      audited: true,
    });
    await close(ctx, draft, "done");
    return "gate";
  },
});

// A trace for one member of the crew: every line it writes, the model's own
// included, says who wrote it and which part of which page it is about.
function agentTrace(trace: ProviderTrace, who: string, detail: EventDetail, auditor: boolean): ProviderTrace {
  return {
    note: (input) => trace.note({
      ...input,
      label: `${who}: ${input.label.charAt(0).toLowerCase()}${input.label.slice(1)}`,
      ...(auditor && input.status === "calling" ? { status: "reviewing" as const } : {}),
      detail: { ...detail, ...input.detail },
    }),
  };
}

const asksForPicture = (markup: string) =>
  (markup.match(/<img\b[^>]*>/gi) ?? []).some((tag) => /\bdata-forge-image\s*=\s*["'][^"']+/i.test(tag));

type Setting = { extract: string; foundation?: string; referenceUrl: string; rebuild?: string };
type Worked =
  | { state: "page"; draft: Draft }
  | { state: "short"; progressed: boolean; reason?: string; stop?: Stop }
  | { state: "halted" };

function cutStop(reply: { outOfTime?: boolean; stats?: StreamStats; content: string }) {
  return {
    reason: reply.outOfTime ? "out_of_time" : reply.stats?.finishReason === "length" ? "length" : "dropped",
    phase: reply.stats?.phase ?? "writing",
    reasoningChars: reply.stats?.reasoningChars || undefined,
    replyChars: reply.content.length || undefined,
  };
}

// The crew at work on one page, inside this step's clock. The builders go side
// by side -- the rest of the page once the top of it is written -- and each
// auditor starts on its part the moment its builder saves it. Every answer is
// saved as it comes, and so is a builder's reply the clock stopped part way.
// Once all four auditors agree the page is kept; if the clock runs short
// first, what is saved is where the next step carries on.
async function workCrew(
  ctx: ActionCtx,
  input: {
    id: Id<"buildDrafts">;
    lease: string;
    draft: Draft;
    deadline: number;
    // The model this step's builders are asked on.
    model: string;
    setting: Setting;
    brief: string;
    base: ReturnType<typeof onboardingMessages>;
    trace: ProviderTrace;
    imagery: boolean;
  },
): Promise<Worked> {
  const { id, lease, draft, deadline, setting, trace } = input;
  const crew = draft.crew!;
  const path = crew.path;
  const where = place(draft, path);
  const detail = { path, page: draft.routes.indexOf(path) + 1, total: draft.routes.length, step: draft.step };
  const written = draft.shell ? { shell: draft.shell, home: draft.pages.find((page) => page.path === "/") } : undefined;
  // Each part's own latest state, from its own saves: parts never write each
  // other's, so none can be overwritten by an older copy of another's.
  const latest = Object.fromEntries(crew.parts.map((part) => [part.name, part])) as Record<PartName, CrewPart>;
  let halted = false;
  let progressed = false;
  let reason: string | undefined;
  let stop: Stop | undefined;
  let topWritten = () => {};
  const top = new Promise<void>((resolve) => {
    topWritten = resolve;
  });

  // A reply that could not be used, or a call that failed: counted against its
  // part, and a few in a row, or one that nothing will change, stop the build.
  async function miss(name: PartName, args: { reason: string; problem?: string; fatal?: boolean }) {
    const result = await ctx.runMutation(internal.buildDraft.partMissed, { id, lease, part: name, ...args });
    if (result.state !== "again") halted = true;
    else latest[name] = result.part!;
  }

  // A call that failed. The clock running out is no part's miss: the part
  // waits for the next step, which starts it with a whole clock, and a step
  // that finishes nothing at all is counted as one (`stepped`).
  async function missed(name: PartName, error: unknown) {
    stop = stopOf(error);
    reason = describe(error);
    if (error instanceof ReplyStopped && error.stop.reason === "out_of_time") return;
    await miss(name, { reason, fatal: !retryable(error) });
  }

  async function build(name: PartName) {
    const part = latest[name];
    const adjusting = Boolean(written) && isChrome(name);
    const partDetail = { ...detail, part: name };
    // A reply another model began is written again rather than carried on.
    const carry = part.partial !== undefined && draft.model === input.model ? part.partial : undefined;
    await trace.note(carry !== undefined
      ? {
          phase: "draft_resume",
          label: `Carrying on the ${PART_NAMES[name]} of ${where} from where it stopped: ${pageName(path)}`,
          status: "calling",
          detail: { ...partDetail, continuation: part.resumes, replyChars: carry.length },
        }
      : {
          phase: "crew_build",
          label: adjusting
            ? `${capital(where)}: fitting the shared ${PART_NAMES[name]} to this page`
            : part.fixes.length
              ? `${capital(where)}: making the auditor's ${part.fixes.length === 1 ? "change" : `${part.fixes.length} changes`} to the ${PART_NAMES[name]}`
              : `${capital(where)}: writing the ${PART_NAMES[name]}`,
          status: "calling",
          detail: { ...partDetail, round: part.round },
        });
    const messages = builderTurn({
      base: input.base,
      extract: setting.extract,
      foundation: setting.foundation,
      brief: input.brief,
      siteName: draft.siteName,
      routes: draft.routes,
      path,
      part,
      written,
      top: name === "body2" ? latest.body1.markup : undefined,
      rebuild: setting.rebuild,
      imagery: name === "body1" && path === "/" && input.imagery ? NEW_IMAGERY : undefined,
      carry,
    });
    let answer: Awaited<ReturnType<typeof callProviderPart>>;
    try {
      answer = await callProviderPart(messages, deadline - Date.now(), agentTrace(trace, `${PART_AGENTS[name]} builder`, partDetail, false), carry !== undefined);
    } catch (error) {
      await missed(name, error);
      return;
    }
    const reply = carry !== undefined ? joinCarry(carry, answer.content) : answer.content;
    // Stopped inside its part: kept as far as it got from the part's opening
    // fence, and the next step carries it on from that character.
    const block = partBlock(reply, name);
    if (answer.cut && block && !block.closed) {
      const result = await ctx.runMutation(internal.buildDraft.partCarried, {
        id, lease, part: name, text: reply.slice(block.index), stop: cutStop(answer),
      });
      if (result.state !== "saved") {
        halted = true;
        return;
      }
      latest[name] = result.part!;
      progressed = true;
      return;
    }
    const read = readPart(reply, { part: name, adjusting, path });
    let problem = "problem" in read ? read.problem : undefined;
    if ("markup" in read) {
      try {
        assertDesignRules({ html: read.markup }, setting.referenceUrl);
      } catch (error) {
        problem = describe(error);
      }
      if (!problem && name === "body1" && path === "/" && input.imagery && !asksForPicture(read.markup)) {
        problem = "a rebuild needs new pictures, and this page asked for none. Ask for at least one with an img whose src is forge-image:1.";
      }
    }
    if (problem || !("markup" in read)) {
      await trace.note({
        phase: "crew_unusable",
        label: `${capital(where)}: the ${PART_NAMES[name]} came back unusable: ${firstSentence(problem)}`,
        level: "warn",
        status: "calling",
        detail: { ...partDetail, replyChars: reply.length },
      });
      await miss(name, { reason: "The agent did not return a website", problem });
      return;
    }
    const saved = await ctx.runMutation(internal.buildDraft.partBuilt, { id, lease, part: name, markup: read.markup, ...(read.title ? { title: read.title } : {}) });
    if (!saved) {
      halted = true;
      return;
    }
    latest[name] = saved;
    progressed = true;
    if (name === "body1") topWritten();
    await trace.note({
      phase: "crew_built",
      label: `${capital(where)}: the ${PART_NAMES[name]} is written`,
      status: "calling",
      detail: { ...partDetail, replyChars: read.markup.length },
    });
  }

  async function audit(name: PartName) {
    const part = latest[name];
    const partDetail = { ...detail, part: name, round: part.round + 1 };
    await trace.note({
      phase: "crew_audit",
      label: `${capital(where)}: the auditor is checking the ${PART_NAMES[name]} against the reference`,
      status: "reviewing",
      detail: partDetail,
    });
    const messages = auditorTurn({
      extract: setting.extract,
      foundation: setting.foundation,
      siteName: draft.siteName,
      routes: draft.routes,
      path,
      part: name,
      ...crewWork({ path, parts: PARTS.map((each) => latest[each]) }, name, written?.shell),
      round: part.round + 1,
      lastFixes: part.asked ?? [],
    });
    let reply: string;
    try {
      reply = await callProvider(messages, undefined, deadline - Date.now(), agentTrace(trace, `${PART_AGENTS[name]} auditor`, partDetail, true), "review");
    } catch (error) {
      await missed(name, error);
      return;
    }
    const verdict = readAudit(reply);
    if (!verdict) {
      await trace.note({
        phase: "crew_unusable",
        label: `${capital(where)}: the auditor's verdict on the ${PART_NAMES[name]} couldn't be read`,
        level: "warn",
        status: "reviewing",
        detail: { ...partDetail, replyChars: reply.length },
      });
      await miss(name, { reason: "The design auditor didn't return a verdict" });
      return;
    }
    const result = await ctx.runMutation(internal.buildDraft.partAudited, { id, lease, part: name, agree: verdict.agree, fixes: verdict.fixes });
    if (result.state === "gone" || result.state === "exhausted") {
      halted = true;
      return;
    }
    latest[name] = result.part!;
    progressed = true;
    await trace.note(verdict.agree
      ? {
          phase: "crew_agreed",
          label: `${capital(where)}: the auditor agreed the ${PART_NAMES[name]} matches the reference`,
          status: "reviewing",
          detail: { ...partDetail, agree: true },
        }
      : {
          phase: "crew_sent_back",
          label: `${capital(where)}: the auditor sent the ${PART_NAMES[name]} back with ${verdict.fixes.length === 1 ? "1 change" : `${verdict.fixes.length} changes`}`,
          level: "warn",
          status: "reviewing",
          detail: { ...partDetail, agree: false },
        });
  }

  async function work(name: PartName) {
    for (;;) {
      if (halted) return;
      const part = latest[name];
      const next = nextFor(part);
      if (next === "done") return;
      if (next === "build" && name === "body2" && latest.body1.markup === undefined) {
        await top;
        if (latest.body1.markup === undefined) return;
        continue;
      }
      if (deadline - Date.now() < (next === "build" ? BUILD_FLOOR_MS : AUDIT_FLOOR_MS)) return;
      if (next === "build") await build(name);
      else await audit(name);
      // Nothing saved -- the clock ran out mid-reply -- leaves the part for the
      // next step, and so does a part saved part way, which the next step
      // carries on.
      if (latest[name] === part || latest[name].partial !== undefined) return;
    }
  }

  if (latest.body1.markup !== undefined) topWritten();
  await Promise.all(PARTS.map(async (name) => {
    try {
      await work(name);
    } finally {
      if (name === "body1") topWritten();
    }
  }));
  if (halted) return { state: "halted" };
  if (PARTS.every((name) => latest[name].agreed)) {
    const kept = await ctx.runMutation(internal.buildDraft.pageDone, { id, lease });
    return kept ? { state: "page", draft: kept } : { state: "halted" };
  }
  return { state: "short", progressed, reason, stop };
}

// One step: the crews at work while the clock allows, each part saved as it
// comes, then the next step queued. `budgetMs` shortens this one step's clock,
// for tests; the chain itself never passes it.
export const write = internalAction({
  args: { id: v.id("buildDrafts"), budgetMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id, budgetMs }): Promise<null> => {
    const claimed = await ctx.runMutation(internal.buildDraft.claim, { id });
    if (!claimed) return null;
    const { lease } = claimed;
    let draft = claimed.draft;
    const deadline = Date.now() + Math.min(Math.max(budgetMs ?? PAGE_STEP_MS, 1000), PAGE_STEP_MS);
    const model = chatRoute("build").model;
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
      const imagery = draft.rebuild && Boolean(imageRoute().apiKey);
      let kept = 0;
      let progressed = false;
      for (;;) {
        const target = nextPage(draft);
        if (target === null) {
          await ctx.runMutation(internal.buildDraft.handOff, { id, lease });
          return null;
        }
        // The clock is short: the step ends at this page boundary, and the
        // next step starts the page's crew with a whole clock of its own.
        if (kept > 0 && deadline - Date.now() < PAGE_FLOOR_MS) {
          await ctx.runMutation(internal.buildDraft.stepped, { id, lease, outcome: "boundary" });
          return null;
        }
        if (draft.crew?.path !== target) {
          const mustered = await ctx.runMutation(internal.buildDraft.muster, { id, lease, path: target });
          if (!mustered) return null;
          draft = mustered;
          await trace.note({
            phase: "crew_page",
            label: draft.shell
              ? `${capital(place(draft, target))}, ${pageName(target)}: writing the page, and checking the shared header and footer on it`
              : `${capital(place(draft, target))}, ${pageName(target)}: writing the header, the page and the footer`,
            status: "calling",
            detail: { path: target, page: draft.routes.indexOf(target) + 1, total: draft.routes.length, step: draft.step },
          });
        }
        const worked = await workCrew(ctx, { id, lease, draft, deadline, model, setting, brief, base, trace, imagery });
        if (worked.state === "halted") return null;
        if (worked.state === "page") {
          draft = worked.draft;
          kept += 1;
          progressed = true;
          continue;
        }
        const moved = progressed || worked.progressed;
        await ctx.runMutation(internal.buildDraft.stepped, {
          id,
          lease,
          outcome: moved ? "boundary" : "nothing",
          ...(moved ? {} : { reason: worked.reason ?? "The agent did not return a website", stop: worked.stop }),
        });
        return null;
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
// the step is started again from the last saved part. A draft that keeps going
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
// `npx convex run buildDraft:inspect`. Addresses, counts and each part's
// rounds only, never a page.
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
        crew: row.crew
          ? {
              path: row.crew.path,
              parts: row.crew.parts.map((part) => ({
                part: part.name,
                agreed: part.agreed,
                round: part.round,
                tries: part.tries,
                chars: part.markup?.length ?? null,
                carried: part.partial !== undefined ? { chars: part.partial.length, resumes: part.resumes ?? 1 } : null,
                fixes: part.fixes.length,
              })),
            }
          : null,
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
