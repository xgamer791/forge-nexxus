// A measured build, written by a swarm of page agents.
//
// A measured reference is more site than one reply can write inside an
// action's ten minutes, and more than one agent should write a page after
// another. So each page has an agent of its own -- at most MAX_PAGES of them
// for a fresh build -- and every agent writes in slices:
//
// - The frame agent writes the shell (the header, the menu, the footer and
//   everything the pages share) with the home page. The other agents wait for
//   that shell, then run side by side, each writing one page into it.
// - A slice is one action with a fresh budget of about seven minutes
//   (SLICE_MS). When it ends, whatever the agent's reply has produced -- the
//   page as far as it got, the thinking as far as it got -- is saved on the
//   agent as its checkpoint, the action ends cleanly, and the agent's next
//   slice is queued at once and carries the reply on from there. The end of a
//   slice is never a failure, and nothing here fails a build for how long it
//   has taken.
// - What stops a build is a real stall: slices in a row that produce nothing,
//   a page that keeps stopping part way or keeps being planned and never
//   written, a provider that refuses, or an agent whose action went quiet and
//   will not start again (rescue).
// - Once every page is written the site goes to the layout check
//   (designGate.ts), in the transaction that finishes the last agent. The
//   check measures every page at phone, tablet and desktop widths exactly as
//   before; nothing here changes what it takes to pass it.
//
// A layout check that sends a site back has it reworked the same way
// (startRework): the frame agent reworks the shell and the home page when the
// check found fault with either, and one agent per other page it found fault
// with reworks that page, side by side.
//
// Every agent runs on DeepSeek v4.1 Flash and nothing else (swarmRoute).
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { elided, lostPageStyles } from "./designCheck";
import { COULD_NOT_REWORK, endGate, failGate, openGate, reworkAgentRequest, reworkedWith, siteOfGate, stillWaiting } from "./designGate";
import { classifyError, providerTrace, recordEvent, type ProviderTrace } from "./diagnostics";
import {
  builtSite, callProviderSlice, describe, designAgentTurn, onboardingMessages, parseReply, parseShellReply, readDraftReply,
  ReplyStopped, reworkPageTurn, swarmRoute, SWARM_MODEL,
} from "./generate";
import { imageRoute } from "./images";
import {
  designHash, DIFFERENT_BUILD, draftTurn, heartbeat, joinThought, keptThought, MOST_RESTARTS, oneTurn, rebuildNote, RESCUE_BATCH,
  STEP_QUIET_MS, stopAttempt, withThought,
} from "./onboarding";
import { BODY_MARKER, designSource, hasPages, normalizePath, siteParts, type BuiltSite, type SitePage } from "./pages";
import { assertDesignRules, capReference, isMeasured, routeSpec } from "./siteDesign";
import type { StreamStats } from "./stream";

// The most pages a fresh build writes, which is the most agents one runs.
export const MAX_PAGES = 5;
// One slice: an action's fresh budget. The platform stops an action at ten
// minutes; a slice hands on well inside that, whatever its reply is doing.
export const SLICE_MS = 420000;
// Slices in a row that may produce nothing at all -- no page, no more of one,
// no thinking -- before the agent is taken to have stalled.
export const STEP_TRIES = 3;
// Slices that may carry one reply on before it is a page that never ends.
export const MOST_RESUMES = 6;
// Slices that may carry thinking on without a word of the page written.
export const MOST_THOUGHTS = 4;
// A ceiling no agent that is getting anywhere comes near, so none can go round
// forever: every mix of the three above fits under it.
const MOST_SLICES = STEP_TRIES * (MOST_RESUMES + MOST_THOUGHTS + 2);
const KEEP_DRAFTS = 20;
// A rework agent's share of the measured differences, at most.
const FIXES_CHARS = 40000;

// What a member reads when a build's agents stall. None names a length of
// time, because none was decided by one.
export const STOPPED_ANSWERING = "The model stopped answering while it was building your website. Try again in a moment.";
export const KEPT_PLANNING = "The model kept planning a page without writing it. Try again.";
export const KEPT_STOPPING = "A page kept stopping part way through. Try again.";

const pageValidator = v.object({ path: v.string(), title: v.string(), body: v.string() });
const wroteValidator = v.object({
  shell: v.optional(v.string()),
  html: v.optional(v.string()),
  pages: v.array(pageValidator),
  summary: v.optional(v.string()),
  clones: v.optional(v.string()),
});
const stopValidator = v.object({
  reason: v.string(),
  phase: v.string(),
  reasoningChars: v.optional(v.number()),
  replyChars: v.optional(v.number()),
});

type Draft = Doc<"buildDrafts">;
type Gate = Doc<"designGates">;
type Agent = Doc<"pageAgents">;
type Wrote = NonNullable<Agent["wrote"]>;
type Owner = { kind: "draft"; draft: Draft } | { kind: "gate"; gate: Gate };

// How the member's log names a page.
function pageName(path: string) {
  return path === "/" ? "home" : path;
}
function place(agent: Pick<Agent, "order" | "total">) {
  return `page ${agent.order} of ${agent.total}`;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lease = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

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
  clones?: string;
  pages: SitePage[];
  // The block the reply was stopped inside, to be carried on by the next slice.
  partial?: { path: string; text: string };
  // Why the page asked for could not be used, for the next slice to put right.
  problem?: string;
};

// What a reply leaves to keep: the shell, when the agent writes it and it
// closed whole and clean; each page the agent writes that closed whole and
// clean; and the block the reply was stopped inside, if it was stopped. A reply
// that ended on its own with its last fence still open finished that block and
// left the fence off, so it is read as closed.
export function readTurn(
  text: string,
  input: { draft: { routes: string[]; pages: SitePage[]; shell?: string }; target: string; cut: boolean; referenceUrl: string; imagery: boolean },
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
    // Stopped inside the shell, the whole reply goes on; stopped inside a page
    // still to write, that page's block does.
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

// Whether another slice could get further. The stream stopping, a reply that
// fell short and a connection that failed are worth another go; a provider
// that refused the request, or a deployment that is not set up, will only say
// the same thing again.
function retryable(error: unknown) {
  if (error instanceof ReplyStopped) return true;
  if (error instanceof ConvexError) return false;
  const status = describe(error).match(/answered (\d{3})/)?.[1];
  return !status || !status.startsWith("4") || status === "408" || status === "429";
}

// Where a reply that stopped short had got to, for the agent's log.
function stopOf(error: unknown) {
  if (error instanceof ReplyStopped) {
    const { stats } = error.stop;
    return { reason: error.stop.reason, phase: stats.phase, reasoningChars: stats.reasoningChars || undefined, replyChars: stats.contentChars || undefined };
  }
  return { reason: classifyError(describe(error)), phase: "none" };
}

function sliceStop(reply: { stats?: StreamStats; content: string; sliced?: { phase: string } }) {
  return {
    reason: reply.sliced ? "slice_end" : reply.stats?.finishReason === "length" ? "length" : "dropped",
    phase: reply.sliced?.phase ?? reply.stats?.phase ?? "writing",
    reasoningChars: reply.stats?.reasoningChars || undefined,
    replyChars: reply.content.length || undefined,
  };
}

// ---------------------------------------------------------------------------
// Owners: a first build's draft, or a layout check's rework round.

async function ownerOf(ctx: MutationCtx, agent: Agent): Promise<Owner | null> {
  if (agent.draftId) {
    const draft = await ctx.db.get(agent.draftId);
    return draft ? { kind: "draft", draft } : null;
  }
  if (agent.gateId) {
    const gate = await ctx.db.get(agent.gateId);
    return gate ? { kind: "gate", gate } : null;
  }
  return null;
}

async function agentsOf(ctx: MutationCtx, owner: Owner, round?: number) {
  if (owner.kind === "draft") {
    return await ctx.db.query("pageAgents").withIndex("by_draft", (q) => q.eq("draftId", owner.draft._id)).collect();
  }
  const gate = owner.gate;
  return await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", gate._id).eq("round", round ?? gate.round)).collect();
}

async function closeAgent(ctx: MutationCtx, agent: Agent, status: "done" | "failed" | "cancelled", error?: string) {
  const fresh = await ctx.db.get(agent._id);
  if (!fresh) return;
  await ctx.db.patch(agent._id, {
    status: fresh.status === "done" && status !== "cancelled" ? "done" : status,
    ...(error ? { error } : {}),
    partial: undefined,
    thought: undefined,
    wrote: undefined,
    lease: undefined,
    updatedAt: Date.now(),
  });
}

async function closeAgents(ctx: MutationCtx, agents: Agent[], status: "done" | "failed" | "cancelled") {
  for (const agent of agents) await closeAgent(ctx, agent, agent.status === "done" ? "done" : status);
}

async function closeDraft(ctx: MutationCtx, draft: Draft, status: "done" | "failed" | "cancelled", error?: string) {
  await ctx.db.patch(draft._id, {
    status,
    ...(error ? { error } : {}),
    shell: undefined,
    pages: [],
    partial: undefined,
    lease: undefined,
    updatedAt: Date.now(),
  });
  await closeAgents(ctx, await agentsOf(ctx, { kind: "draft", draft }), status === "done" ? "done" : status);
}

// Ends the build a draft belongs to: its credits go back and the member is
// told why, in the words any failed build uses. `stalled` is a draft that
// went quiet rather than one that said what stopped it.
async function failDraft(ctx: MutationCtx, draft: Draft, reason?: string, stalled = false) {
  await closeDraft(ctx, draft, "failed", reason);
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
    await closeDraft(ctx, draft, "cancelled");
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

// Whether the owner still wants this agent's work: a draft still being written
// for the build it belongs to, or a check still reworking the round the agent
// belongs to, for a build still waiting on it.
async function wanted(ctx: MutationCtx, agent: Agent): Promise<Owner | null> {
  const owner = await ownerOf(ctx, agent);
  if (!owner) return null;
  if (owner.kind === "draft") {
    if (owner.draft.status !== "writing" || owner.draft.agents === undefined) return null;
    if (await settle(ctx, owner.draft)) return null;
    return owner;
  }
  const gate = owner.gate;
  if (gate.status !== "reworking" || gate.round !== agent.round) return null;
  if (!(await stillWaiting(ctx, gate))) {
    await endGate(ctx, gate, "cancelled");
    await closeAgents(ctx, await agentsOf(ctx, owner, agent.round), "cancelled");
    return null;
  }
  return owner;
}

// The attempt's own row hears that its build moved: that is what its watchdog
// reads, alongside the agents' own heartbeats.
async function touch(ctx: MutationCtx, owner: Owner) {
  const onboardingId = owner.kind === "draft" ? owner.draft.onboardingId : owner.gate.onboardingId;
  if (onboardingId && await ctx.db.get(onboardingId)) await ctx.db.patch(onboardingId, { updatedAt: Date.now() });
  if (owner.kind === "gate" && await ctx.db.get(owner.gate._id)) await ctx.db.patch(owner.gate._id, { updatedAt: Date.now() });
}

async function prune(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db.query("buildDrafts").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").collect();
  for (const row of rows.filter((row) => row.status !== "writing").slice(KEEP_DRAFTS - 1)) {
    for (const agent of await ctx.db.query("pageAgents").withIndex("by_draft", (q) => q.eq("draftId", row._id)).collect()) {
      await ctx.db.delete(agent._id);
    }
    await ctx.db.delete(row._id);
  }
}

// At most MAX_PAGES agents write at once for one owner. A fresh build never
// has more; a rework of a site from before the cap waits its turn.
async function releaseWaiting(ctx: MutationCtx, owner: Owner, agents: Agent[]) {
  const now = Date.now();
  let running = agents.filter((agent) => agent.status === "writing").length;
  const frame = agents.find((agent) => agent.role === "frame");
  if (frame && frame.status !== "done") return;
  for (const agent of agents.filter((agent) => agent.status === "waiting").sort((a, b) => a.order - b.order)) {
    if (running >= MAX_PAGES) break;
    await ctx.db.patch(agent._id, { status: "writing", beatAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId: agent._id });
    running += 1;
  }
  await touch(ctx, owner);
}

// ---------------------------------------------------------------------------
// A fresh build's swarm.

function newAgent(input: {
  userId: Id<"users">;
  runId: Id<"buildRuns">;
  path: string;
  role: "frame" | "page";
  order: number;
  total: number;
  status: "waiting" | "writing" | "done";
  owner: { draftId: Id<"buildDrafts"> } | { gateId: Id<"designGates">; round: number };
  fixes?: string[];
  problem?: string;
  wrote?: Wrote;
  partial?: { text: string; resumes: number };
}) {
  const now = Date.now();
  return {
    userId: input.userId,
    runId: input.runId,
    ...input.owner,
    path: input.path,
    role: input.role,
    order: input.order,
    total: input.total,
    ...(input.fixes ? { fixes: input.fixes } : {}),
    ...(input.problem ? { problem: input.problem } : {}),
    ...(input.wrote ? { wrote: input.wrote } : {}),
    ...(input.partial ? { partial: input.partial } : {}),
    model: SWARM_MODEL,
    status: input.status,
    beatAt: now,
    slice: 0,
    tries: 0,
    restarts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// The build's hand-off, once its credits are held: the draft, one agent per
// page, and the frame agent's first slice queued straight away. The page
// agents wait for the frame agent's shell.
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
    measuredRoutes: v.optional(v.number()),
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
    const routes = args.routes.slice(0, MAX_PAGES);
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
      agents: routes.length,
      createdAt: now,
      updatedAt: now,
    });
    let frameId: Id<"pageAgents"> | undefined;
    for (const [index, path] of routes.entries()) {
      const agentId = await ctx.db.insert("pageAgents", newAgent({
        userId: row.userId,
        runId: args.runId,
        owner: { draftId: id },
        path,
        role: index === 0 ? "frame" : "page",
        order: index + 1,
        total: routes.length,
        status: index === 0 ? "writing" : "waiting",
      }));
      if (index === 0) frameId = agentId;
    }
    await recordEvent(ctx, {
      runId: args.runId,
      userId: row.userId,
      phase: "draft_start",
      label: routes.length === 1 ? "Writing your website" : `Writing your ${routes.length} pages, one agent per page`,
      status: "calling",
      detail: { total: routes.length, agents: routes.length, model: SWARM_MODEL },
    });
    await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId: frameId! });
    return id;
  },
});

// Every page is written: the site goes to the layout check, in the same
// transaction that finishes the last agent. It passes the checks a one-reply
// build passes on its way there -- the design rules across the whole site, and
// on a rebuild, not the design that was thrown away. A site that repeats the
// discarded design is written again from the frame up, once.
async function handOff(ctx: MutationCtx, draft: Draft, agents: Agent[]) {
  const frame = agents.find((agent) => agent.role === "frame");
  if (!frame?.wrote) return "gone" as const;
  const written = agents.flatMap((agent) => agent.wrote?.pages ?? []);
  const one = draft.routes.length === 1;
  const pages: SitePage[] = [];
  for (const page of one ? written : draft.routes.flatMap((path) => written.filter((kept) => kept.path === path))) {
    if (!pages.some((kept) => kept.path === page.path)) pages.push(page);
  }
  const site: BuiltSite = frame.wrote.html !== undefined ? { html: frame.wrote.html } : { shell: frame.wrote.shell, pages };
  if (frame.wrote.html === undefined && (!frame.wrote.shell || (!one && pages.length !== draft.routes.length))) return "gone" as const;
  const row = (await ctx.db.get(draft.onboardingId))!;
  const design = (await ctx.db.get(draft.designId))!;
  let fault: string | undefined;
  try {
    assertDesignRules(site, design.referenceUrl);
  } catch (error) {
    fault = describe(error);
  }
  if (!fault && row.discardedDesignHashes?.includes(await designHash(designSource(site)))) {
    if ((frame.redesigns ?? 0) < 1) {
      const now = Date.now();
      for (const agent of agents) {
        await ctx.db.patch(agent._id, {
          status: agent.role === "frame" ? "writing" : "waiting",
          wrote: undefined,
          partial: undefined,
          thought: undefined,
          lease: undefined,
          tries: 0,
          problem: agent.role === "frame" ? DIFFERENT_BUILD : undefined,
          ...(agent.role === "frame" ? { redesigns: (agent.redesigns ?? 0) + 1 } : {}),
          beatAt: now,
          updatedAt: now,
        });
      }
      await recordEvent(ctx, {
        runId: draft.runId, userId: draft.userId, phase: "draft_redesign", level: "warn",
        label: "The site matched a discarded design, so it is being written again", status: "calling",
      });
      await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId: frame._id });
      return "redesign" as const;
    }
    fault = "The model repeated the discarded design. Rebuild again to request a new one.";
  }
  if (fault) {
    await failDraft(ctx, draft, fault);
    return "failed" as const;
  }
  await recordEvent(ctx, {
    runId: draft.runId, userId: draft.userId, phase: "draft_done",
    label: one ? "Wrote your website" : `Wrote all ${draft.routes.length} pages`,
    status: "calling",
    detail: { total: draft.routes.length, agents: agents.length, htmlChars: siteParts(site).join("").length },
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
    ...site,
    summary: frame.wrote.summary ?? "",
  });
  await closeDraft(ctx, draft, "done");
  return "gate" as const;
}

// ---------------------------------------------------------------------------
// A layout check's rework swarm.

// Which agent each of the check's measured differences goes to. The header,
// the menu and the footer live in the shell, and the home page is written with
// it, so those go to the frame agent; every other page's own differences go to
// that page's agent. A line that carries on the difference before it goes with
// it. A route the reference does not have is taken out of the site; one it has
// and the site does not is written.
export function assignFixes(fixes: readonly string[], paths: readonly string[]) {
  const FRAME = "\u0000frame";
  const frame: string[] = [];
  const pages = new Map<string, string[]>();
  const missing = new Set<string>();
  const extra = new Set<string>();
  let target: string | null = null;
  const put = (to: string, note: string) => {
    target = to;
    if (to === FRAME) frame.push(note);
    else pages.set(to, [...(pages.get(to) ?? []), note]);
  };
  for (const fix of fixes) {
    const route = fix.match(/^Route (\/\S*) (is missing|has no page in the reference)/);
    if (route) {
      const path = normalizePath(route[1]) ?? route[1];
      if (route[2] === "is missing") {
        missing.add(path);
        put(path === "/" ? FRAME : path, fix);
      } else {
        extra.add(path);
        target = null;
      }
      continue;
    }
    const at = fix.match(/^(\/\S*) at (?:phone|tablet|desktop) \(\d+px\)(?:, (\w+) \()?/);
    if (at) {
      const path = normalizePath(at[1]) ?? at[1];
      const region = at[2];
      const chrome = region === "header" || region === "menu" || region === "footer";
      put(path === "/" || chrome || (!paths.includes(path) && !missing.has(path)) ? FRAME : path, fix);
      continue;
    }
    if (/^\s/.test(fix) && target !== null) {
      put(target, fix);
      continue;
    }
    put(FRAME, fix);
  }
  return { frame, pages, missing, extra };
}

function capped(fixes: string[]) {
  const kept: string[] = [];
  let size = 0;
  for (const fix of fixes) {
    if (size + fix.length > FIXES_CHARS) break;
    kept.push(fix);
    size += fix.length;
  }
  return kept;
}

// A check that sent its site back has it reworked by agents: the frame agent
// first when the shell or the home page needs it, then one agent per other
// page that needs it, side by side. `problem` is why the last rework of this
// round could not be used, which the frame agent is told.
export async function startRework(ctx: MutationCtx, gate: Gate, problem?: string) {
  const owner: Owner = { kind: "gate", gate };
  // An earlier go at this round is over: its agents go, so the round is
  // finished by this go's agents alone. A slice of theirs still running finds
  // its agent gone and writes nothing.
  for (const agent of await agentsOf(ctx, owner)) await ctx.db.delete(agent._id);
  const site = siteOfGate(gate);
  const inPages = hasPages(site);
  const paths = inPages ? site.pages.map((page) => page.path) : ["/"];
  const assigned = assignFixes(gate.fixes, paths);
  const lastFailing = gate.results.at(-1)?.failing ?? [];
  const pageWork = inPages ? [...assigned.pages.keys()].filter((path) => path !== "/") : [];
  const needsFrame = !inPages || Boolean(problem) || assigned.frame.length > 0 || pageWork.length === 0;
  const frameFixes = assigned.frame.length ? assigned.frame : pageWork.length ? [] : [...gate.fixes, ...lastFailing.map((line) => `${line} is below the bar.`)];
  const total = (needsFrame ? 1 : 0) + pageWork.length;
  const order = (path: string) => Math.max(1, paths.indexOf(path) + 1);
  const scheduled: Id<"pageAgents">[] = [];
  if (needsFrame) {
    scheduled.push(await ctx.db.insert("pageAgents", newAgent({
      userId: gate.userId, runId: gate.runId, owner: { gateId: gate._id, round: gate.round },
      path: "/", role: "frame", order: 1, total, status: "writing", fixes: capped(frameFixes), problem,
    })));
  }
  for (const path of pageWork) {
    const agentId = await ctx.db.insert("pageAgents", newAgent({
      userId: gate.userId, runId: gate.runId, owner: { gateId: gate._id, round: gate.round },
      path, role: "page", order: order(path), total, status: needsFrame ? "waiting" : "writing",
      fixes: capped(assigned.pages.get(path) ?? []),
    }));
    if (!needsFrame && scheduled.length < MAX_PAGES) scheduled.push(agentId);
    else if (!needsFrame) await ctx.db.patch(agentId, { status: "waiting" });
  }
  for (const agentId of scheduled) await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId });
  await recordEvent(ctx, {
    runId: gate.runId, userId: gate.userId, phase: "rework_start",
    label: total === 1 && needsFrame
      ? `Reworking the layout after round ${gate.round} of the layout check`
      : `Reworking ${total} parts of the site side by side after round ${gate.round} of the layout check`,
    status: "calling",
    detail: { round: gate.round, agents: total, model: SWARM_MODEL },
  });
  await touch(ctx, owner);
}

// Every rework agent of the round is done: the site as they left it, checked
// the way a rework always was -- the shell whole, written out in full, still
// holding the page marker and every style the pages use -- then handed back
// to the check. A rework that fails those checks is tried again.
async function reworkDone(ctx: MutationCtx, gate: Gate, agents: Agent[]) {
  const before = siteOfGate(gate);
  const frame = agents.find((agent) => agent.role === "frame");
  const design = await ctx.db.query("siteDesignPackages").withIndex("by_site", (q) => q.eq("siteId", gate.siteId)).first();
  let problem: string | undefined;
  let site: BuiltSite;
  if (!hasPages(before)) {
    site = { html: frame?.wrote?.html ?? before.html };
  } else {
    const { extra } = assignFixes(gate.fixes, before.pages.map((page) => page.path));
    const shell = frame?.wrote?.shell ?? before.shell;
    const reworked = agents.flatMap((agent) => agent.wrote?.pages ?? []);
    const pages = before.pages
      .filter((page) => !extra.has(page.path))
      .map((page) => reworked.find((next) => next.path === page.path) ?? page);
    for (const page of reworked) if (!pages.some((kept) => kept.path === page.path) && !extra.has(page.path)) pages.push(page);
    site = { shell, pages };
    if (before.shell.includes(BODY_MARKER) && !shell.includes(BODY_MARKER)) {
      problem = `the shell lost its ${BODY_MARKER} marker, so no page had anywhere to go.`;
    }
    const gap = !problem ? elided(shell) : null;
    if (gap) problem = `the shell has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`;
    const lost = !problem ? lostPageStyles(before.shell, shell, pages) : [];
    if (lost.length) {
      problem = `the shell dropped the styles the pages use for ${lost.slice(0, 12).map((name) => `.${name}`).join(", ")}. Keep every one of them.`;
    }
  }
  if (!problem && design) {
    try {
      assertDesignRules(site, design.referenceUrl);
    } catch (error) {
      problem = describe(error);
    }
  }
  await closeAgents(ctx, agents, "done");
  if (problem) {
    await reworkTrouble(ctx, gate, problem);
    return;
  }
  await recordEvent(ctx, {
    runId: gate.runId, userId: gate.userId, phase: "layout_rework_done",
    label: "The builder sent back its rework",
    detail: { round: gate.round, agents: agents.length, htmlChars: siteParts(site).join("").length },
  });
  await reworkedWith(ctx, gate, site);
}

// A rework that could not be used, or whose agents stalled: another go while
// the check has had fewer than a few of those in a row, and then the build
// stops with nothing saved and its credits back.
async function reworkTrouble(ctx: MutationCtx, gate: Gate, problem?: string) {
  const fresh = await ctx.db.get(gate._id);
  if (!fresh || fresh.status !== "reworking") return;
  const trouble = fresh.trouble + 1;
  if (trouble > 2) {
    await ctx.db.patch(fresh._id, { trouble, updatedAt: Date.now() });
    await failGate(ctx, fresh, COULD_NOT_REWORK);
    return;
  }
  await ctx.db.patch(fresh._id, { trouble, problem, updatedAt: Date.now() });
  await startRework(ctx, { ...fresh, trouble, problem }, problem);
}

// ---------------------------------------------------------------------------
// An agent's slice.

// The start of a slice. One copy holds an agent at a time: another stops here,
// and so does any copy once the agent's owner no longer wants its work.
export const claimAgent = internalMutation({
  args: { agentId: v.id("pageAgents") },
  handler: async (ctx, { agentId }): Promise<{ agent: Agent; lease: string } | null> => {
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.status !== "writing") return null;
    const now = Date.now();
    if (agent.lease && now - agent.beatAt < STEP_QUIET_MS) return null;
    const owner = await wanted(ctx, agent);
    if (!owner) {
      await closeAgent(ctx, agent, "cancelled");
      return null;
    }
    if (agent.slice >= MOST_SLICES) {
      await recordEvent(ctx, {
        runId: agent.runId, userId: agent.userId, phase: "agent_failed", level: "error",
        label: `${capital(place(agent))} took more slices than any page needs: ${pageName(agent.path)}`,
        detail: { path: agent.path, page: agent.order, total: agent.total, slice: agent.slice },
      });
      await failSwarm(ctx, agent, owner, KEPT_STOPPING);
      return null;
    }
    const held = lease();
    const next = { lease: held, beatAt: now, slice: agent.slice + 1, updatedAt: now };
    await ctx.db.patch(agentId, next);
    await touch(ctx, owner);
    return { agent: { ...agent, ...next }, lease: held };
  },
});

// A sign of life from the copy that holds the agent.
export const beatAgent = internalMutation({
  args: { agentId: v.id("pageAgents"), lease: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { agentId, lease: held }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.status !== "writing" || agent.lease !== held) return false;
    await ctx.db.patch(agentId, { beatAt: Date.now() });
    return true;
  },
});

// Everything a slice reads besides its agent: the brief and the measured spec
// a first build is written from, the frame agent's shell and home page for a
// page agent, or the site as the check holds it for a rework agent.
export const agentSetting = internalQuery({
  args: { agentId: v.id("pageAgents") },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent) return null;
    if (agent.draftId) {
      const draft = await ctx.db.get(agent.draftId);
      if (!draft) return null;
      const row = await ctx.db.get(draft.onboardingId);
      const design = await ctx.db.get(draft.designId);
      if (!row?.briefStorageId || !design) return null;
      const frame = agent.role === "page"
        ? (await ctx.db.query("pageAgents").withIndex("by_draft", (q) => q.eq("draftId", draft._id)).collect()).find((other) => other.role === "frame")
        : undefined;
      return {
        kind: "draft" as const,
        siteName: draft.siteName,
        memory: draft.memory ?? null,
        routes: draft.routes,
        rebuild: draft.rebuild ? rebuildNote(draft.onboardingId, draft.attempt, row.revision) : undefined,
        imagery: draft.rebuild && Boolean(imageRoute().apiKey),
        briefStorageId: row.briefStorageId,
        spec: design.prompt,
        referenceUrl: design.referenceUrl,
        frame: frame?.wrote ? { shell: frame.wrote.shell, summary: frame.wrote.summary, pages: frame.wrote.pages } : undefined,
      };
    }
    if (agent.gateId) {
      const gate = await ctx.db.get(agent.gateId);
      if (!gate) return null;
      const design = await ctx.db.query("siteDesignPackages").withIndex("by_site", (q) => q.eq("siteId", gate.siteId)).first();
      if (!design || design.buildEpoch !== gate.epoch || !isMeasured(design)) return null;
      const agents = await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", gate._id).eq("round", agent.round)).collect();
      const frame = agents.find((other) => other.role === "frame");
      return {
        kind: "gate" as const,
        siteName: gate.siteName,
        site: siteOfGate(gate),
        spec: design.prompt,
        referenceUrl: design.referenceUrl,
        frame: frame?.wrote ? { shell: frame.wrote.shell, summary: frame.wrote.summary, pages: frame.wrote.pages } : undefined,
      };
    }
    return null;
  },
});

// The end of a slice, and the agent's next slice queued: its page whole, its
// reply carried on as far as it got, its thinking carried on, or nothing to
// show -- which the next slice tries again, until the tries run out and the
// agent is taken to have stalled.
export const ended = internalMutation({
  args: {
    agentId: v.id("pageAgents"),
    lease: v.string(),
    outcome: v.union(v.literal("done"), v.literal("partial"), v.literal("thought"), v.literal("nothing")),
    // What the slice finished: the frame agent's shell as soon as it is whole,
    // and, when done, the agent's page.
    wrote: v.optional(wroteValidator),
    // The reply as far as it got, and the thinking as far as it got.
    partial: v.optional(v.string()),
    thought: v.optional(v.string()),
    // What stopped a slice that finished nothing, in the member's words.
    reason: v.optional(v.string()),
    // Why a reply could not be used, in the model's.
    problem: v.optional(v.string()),
    // The reply finished and could not be used: its checkpoint goes, and the
    // next slice starts the page again with the problem.
    restart: v.optional(v.boolean()),
    stop: v.optional(stopValidator),
    // Nothing another slice could change: the build stops now.
    fatal: v.optional(v.boolean()),
  },
  returns: v.union(v.literal("next"), v.literal("done"), v.literal("failed"), v.literal("gone")),
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.status !== "writing" || agent.lease !== args.lease) return "gone";
    const owner = await wanted(ctx, agent);
    if (!owner) {
      await closeAgent(ctx, agent, "cancelled");
      return "gone";
    }
    const now = Date.now();
    const lastStop = args.stop ? { ...args.stop, at: now } : agent.lastStop;
    const wrote: Wrote | undefined = args.wrote
      ? {
        shell: args.wrote.shell ?? agent.wrote?.shell,
        html: args.wrote.html ?? agent.wrote?.html,
        pages: [...(agent.wrote?.pages ?? []), ...args.wrote.pages.filter((page) => !(agent.wrote?.pages ?? []).some((kept) => kept.path === page.path))],
        summary: agent.wrote?.summary ?? args.wrote.summary,
        clones: agent.wrote?.clones ?? args.wrote.clones,
      }
      : agent.wrote;
    const base = { lease: undefined, beatAt: now, updatedAt: now, lastStop, wrote };
    const detail = { path: agent.path, page: agent.order, total: agent.total, slice: agent.slice, ...(agent.round ? { round: agent.round } : {}) };
    const where = place(agent);
    if (args.outcome === "done") {
      await ctx.db.patch(agent._id, { ...base, status: "done", partial: undefined, thought: undefined, tries: 0, restarts: 0, problem: undefined });
      await recordEvent(ctx, {
        runId: agent.runId, userId: agent.userId, phase: owner.kind === "draft" ? "draft_page_done" : "rework_page_done",
        label: owner.kind === "draft"
          ? agent.total === 1 ? "Wrote the website" : `Wrote ${where}: ${pageName(agent.path)}`
          : agent.role === "frame" ? "Reworked the header, menu, footer and home page" : `Reworked ${where}: ${pageName(agent.path)}`,
        status: "calling",
        detail: { ...detail, replyChars: (wrote?.pages ?? []).reduce((sum, page) => sum + page.body.length, 0) + (wrote?.shell?.length ?? wrote?.html?.length ?? 0) },
      });
      const agents = (await agentsOf(ctx, owner, agent.round)).map((other) => (other._id === agent._id ? { ...other, ...base, status: "done" as const } : other));
      if (agents.every((other) => other.status === "done")) {
        if (owner.kind === "draft") await handOff(ctx, owner.draft, agents);
        else await reworkDone(ctx, owner.gate, agents);
        return "done";
      }
      await releaseWaiting(ctx, owner, agents);
      return "done";
    }
    const patch: Partial<Agent> = { ...base };
    if (args.outcome === "partial" && args.partial !== undefined) {
      // A shell just kept leaves the home page's block to carry, which is a
      // new reply; anything else carries on the reply the agent was carrying.
      const resumes = agent.partial && !(args.wrote?.shell && !agent.wrote?.shell) ? agent.partial.resumes + 1 : 1;
      if (resumes > MOST_RESUMES) {
        await ctx.db.patch(agent._id, patch);
        await recordEvent(ctx, {
          runId: agent.runId, userId: agent.userId, phase: "agent_failed", level: "error",
          label: `Stopped at ${where}: it kept stopping part way`, detail: { ...detail, continuation: resumes },
        });
        await failSwarm(ctx, { ...agent, ...patch }, owner, KEPT_STOPPING);
        return "failed";
      }
      const thought = args.thought?.trim() ? { text: keptThought(args.thought), slices: 0 } : undefined;
      Object.assign(patch, { partial: { text: args.partial, resumes }, thought, tries: 0, restarts: 0, problem: undefined });
      await recordEvent(ctx, {
        runId: agent.runId, userId: agent.userId, phase: "agent_checkpoint",
        label: `Checkpoint: saved ${where} as far as it got: ${pageName(agent.path)}`,
        status: "calling",
        detail: {
          ...detail, continuation: resumes, replyChars: args.partial.length, stopReason: args.stop?.reason,
          streamPhase: args.stop?.phase, reasoningChars: args.stop?.reasoningChars, thoughtChars: thought?.text.length,
        },
      });
    } else if (args.outcome === "thought" && args.thought !== undefined) {
      const slices = (agent.thought?.slices ?? 0) + 1;
      if (slices > MOST_THOUGHTS) {
        await ctx.db.patch(agent._id, patch);
        await recordEvent(ctx, {
          runId: agent.runId, userId: agent.userId, phase: "agent_failed", level: "error",
          label: `Stopped at ${where}: the model kept planning it without writing it`, detail: { ...detail, continuation: slices },
        });
        await failSwarm(ctx, { ...agent, ...patch }, owner, KEPT_PLANNING);
        return "failed";
      }
      const text = joinThought(agent.thought?.text, args.thought);
      Object.assign(patch, { thought: { text, slices }, tries: 0, restarts: 0 });
      await recordEvent(ctx, {
        runId: agent.runId, userId: agent.userId, phase: "agent_checkpoint",
        label: `Checkpoint: saved the thinking on ${where} so far: ${pageName(agent.path)}`,
        status: "calling",
        detail: { ...detail, continuation: slices, reasoningChars: args.stop?.reasoningChars, thoughtChars: text.length, stopReason: args.stop?.reason, streamPhase: args.stop?.phase },
      });
    } else {
      // A shell kept is progress even when the home page with it is not.
      const progress = Boolean(args.wrote?.shell && !agent.wrote?.shell);
      const tries = progress ? 0 : agent.tries + 1;
      if (!progress && (args.fatal || tries >= STEP_TRIES)) {
        await ctx.db.patch(agent._id, { ...patch, tries });
        await recordEvent(ctx, {
          runId: agent.runId, userId: agent.userId, phase: "agent_failed", level: "error",
          label: `Stopped at ${where}: ${pageName(agent.path)}`,
          detail: { ...detail, errorClass: classifyError(args.reason ?? ""), stopReason: args.stop?.reason, streamPhase: args.stop?.phase },
        });
        await failSwarm(ctx, { ...agent, ...patch, tries }, owner, args.reason ?? "The agent did not return a website");
        return "failed";
      }
      Object.assign(patch, { tries, problem: args.problem, ...(args.restart || progress ? { partial: undefined, thought: undefined } : {}) });
    }
    await ctx.db.patch(agent._id, patch);
    await touch(ctx, owner);
    await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId: agent._id });
    return "next";
  },
});

// An agent that stalled ends what it belongs to: a first build stops with
// what stopped it and its credits back; a rework is tried again, a few times.
async function failSwarm(ctx: MutationCtx, agent: Agent, owner: Owner, reason?: string, stalled = false) {
  await closeAgent(ctx, agent, "failed", reason);
  if (owner.kind === "draft") {
    await failDraft(ctx, owner.draft, reason, stalled);
    return;
  }
  await closeAgents(ctx, await agentsOf(ctx, owner, agent.round), "cancelled");
  await reworkTrouble(ctx, owner.gate);
}

// What an agent is asked on this slice.
type Setting = NonNullable<FunctionReturnType<typeof internal.buildDraft.agentSetting>>;

function agentMessages(agent: Agent, setting: Setting, brief: string | undefined, carry: string | undefined) {
  const thought = agent.thought;
  if (setting.kind === "draft") {
    const base = onboardingMessages(setting.siteName, setting.memory);
    if (setting.routes.length === 1) {
      return withThought(oneTurn({
        base, spec: setting.spec, brief: brief ?? "", rebuild: setting.rebuild, imagery: setting.imagery, problem: agent.problem, carry,
      }), thought);
    }
    const shell = agent.role === "frame" ? agent.wrote?.shell : setting.frame?.shell;
    const written = shell
      ? { summary: agent.role === "frame" ? agent.wrote?.summary : setting.frame?.summary, shell, pages: agent.role === "frame" ? [] : setting.frame?.pages ?? [] }
      : undefined;
    return withThought(draftTurn({
      base,
      spec: setting.spec,
      routes: setting.routes,
      siteName: setting.siteName,
      brief: brief ?? "",
      target: agent.path,
      rebuild: setting.rebuild,
      imagery: setting.imagery,
      written,
      problem: agent.problem,
      carry,
    }), thought);
  }
  const site = setting.site;
  const fixes = agent.fixes ?? [];
  if (agent.role === "frame") {
    const request = reworkAgentRequest({ fixes, part: hasPages(site) ? "frame" : "document", problem: agent.problem });
    const messages = designAgentTurn(setting.siteName, site, undefined, request, setting.spec);
    if (carry !== undefined) messages.push({ role: "assistant", content: carry }, { role: "user", content: CARRY_ON_REWORK });
    return withThought(messages, thought);
  }
  const shell = setting.frame?.shell ?? (hasPages(site) ? site.shell : "");
  const current = hasPages(site) ? site.pages.find((page) => page.path === agent.path) ?? null : null;
  const request = reworkAgentRequest({ fixes, part: "page", path: agent.path, missing: !current, problem: agent.problem });
  const messages = reworkPageTurn(setting.siteName, { shell, page: current, path: agent.path }, request, routeSpec(setting.spec, [agent.path]));
  if (carry !== undefined) messages.push({ role: "assistant", content: carry }, { role: "user", content: CARRY_ON_REWORK });
  return withThought(messages, thought);
}

const CARRY_ON_REWORK =
  "Your reply stopped part way through. Continue from the exact character where it stopped. " +
  "Do not repeat anything already written, do not start the block again, and do not add commentary or open a new code fence. " +
  "Output only the rest, and close each block's code fence where it ends.";

// What a slice's reply leaves: done, a checkpoint to carry, or nothing, for
// each kind of agent.
type Read =
  | { outcome: "done"; wrote: Wrote }
  | { outcome: "partial"; partial: string; wrote?: Wrote }
  | { outcome: "nothing"; problem?: string; wrote?: Wrote; restart: boolean };

function readReply(agent: Agent, setting: Setting, text: string, cut: boolean): Read {
  const begun = /```|<!doctype html/i.test(text);
  if (setting.kind === "draft" && setting.routes.length === 1) {
    // One page: read the way a one-reply build always was.
    if (cut) return begun ? { outcome: "partial", partial: text } : { outcome: "nothing", problem: undefined, restart: false };
    let site: BuiltSite | null = null;
    let summary = "";
    let clones: string | undefined;
    try {
      const parsed = parseReply(text);
      site = builtSite(parsed);
      summary = parsed.summary;
      clones = parsed.clones;
    } catch {
      return { outcome: "nothing", problem: "the reply did not contain a complete website", restart: true };
    }
    if (!site) return { outcome: "nothing", problem: "the reply did not contain a website", restart: true };
    try {
      assertDesignRules(site, setting.referenceUrl);
    } catch (error) {
      return { outcome: "nothing", problem: describe(error), restart: true };
    }
    if (setting.imagery) {
      const requested = (siteParts(site).join("\n").match(/<img\b[^>]*>/gi) ?? []).some((tag) => /\bdata-forge-image\s*=\s*["'][^"']+/i.test(tag));
      if (!requested) return { outcome: "nothing", problem: "The rebuild did not include its required new imagery. Try rebuilding again.", restart: true };
    }
    return { outcome: "done", wrote: { ...(site.html !== undefined ? { html: site.html } : { shell: site.shell }), pages: site.pages ?? [], summary, clones } };
  }
  if (setting.kind === "gate" && agent.role === "frame") {
    const before = setting.site;
    if (cut) return begun ? { outcome: "partial", partial: text } : { outcome: "nothing", restart: false };
    if (!hasPages(before)) {
      let site: BuiltSite | null = null;
      try {
        site = builtSite(parseReply(text));
      } catch {
        return { outcome: "nothing", problem: "the page stopped before </html>. Send back the whole page, closed with its fence.", restart: true };
      }
      if (!site?.html) return { outcome: "nothing", problem: "the reply had no page in it. Send back the whole page.", restart: true };
      const gap = elided(site.html);
      if (gap) return { outcome: "nothing", problem: `the page has a comment standing in for part of it (${gap}). Write every line of it out in full, with no comment in place of code.`, restart: true };
      return { outcome: "done", wrote: { html: site.html, pages: [] } };
    }
    let back: ReturnType<typeof parseShellReply>;
    try {
      back = parseShellReply(text);
    } catch {
      return { outcome: "nothing", problem: "the shell was missing, or stopped before </html>. Send back the whole shell, closed with its fence.", restart: true };
    }
    if (before.shell.includes(BODY_MARKER) && !back.shell.includes(BODY_MARKER)) {
      return { outcome: "nothing", problem: `the shell lost its ${BODY_MARKER} marker, so no page had anywhere to go.`, restart: true };
    }
    const fault = shellFault(back.shell, setting.referenceUrl);
    if (fault) return { outcome: "nothing", problem: fault, restart: true };
    const home = back.pages.find((page) => page.path === "/");
    if (home) {
      const homeFault = pageFault(home, back.shell, setting.referenceUrl, false);
      if (homeFault) return { outcome: "nothing", problem: homeFault, restart: true };
    }
    return { outcome: "done", wrote: { shell: back.shell, pages: home ? [home] : [], summary: back.summary, clones: back.clones } };
  }
  // A page -- or, for a first build's frame agent, the shell and the home page.
  const frame = agent.role === "frame" && setting.kind === "draft";
  const shell = frame ? agent.wrote?.shell : setting.frame?.shell ?? (setting.kind === "gate" && hasPages(setting.site) ? setting.site.shell : undefined);
  const turn = readTurn(text, {
    draft: { routes: [agent.path], pages: [], shell },
    target: agent.path,
    cut,
    referenceUrl: setting.referenceUrl,
    imagery: setting.kind === "draft" && setting.imagery,
  });
  const kept: Wrote | undefined = turn.shell ? { shell: turn.shell, summary: turn.summary, clones: turn.clones, pages: [] } : undefined;
  const page = turn.pages.find((written) => written.path === agent.path);
  if (page && (!frame || shell || turn.shell)) {
    return { outcome: "done", wrote: { ...(kept ?? {}), pages: [page] } };
  }
  if (turn.partial) return { outcome: "partial", partial: turn.partial.text, wrote: kept };
  if (cut && !begun) return { outcome: "nothing", restart: false };
  return { outcome: "nothing", problem: turn.problem, wrote: kept, restart: !cut };
}

// One slice of one agent: its reply until it is whole or the slice ends, then
// the checkpoint and the next slice queued. `budgetMs` shortens this one
// slice, for tests; the chain itself never passes it.
export const run = internalAction({
  args: { agentId: v.id("pageAgents"), budgetMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { agentId, budgetMs }): Promise<null> => {
    const claimed = await ctx.runMutation(internal.buildDraft.claimAgent, { agentId });
    if (!claimed) return null;
    const { lease: held, agent } = claimed;
    const deadline = Date.now() + Math.min(Math.max(budgetMs ?? SLICE_MS, 1000), SLICE_MS);
    const stopBeating = heartbeat(() => ctx.runMutation(internal.buildDraft.beatAgent, { agentId, lease: held }));
    const trace: ProviderTrace = providerTrace(ctx, agent.runId, agent.userId);
    const end = (args: Omit<FunctionArgs<typeof internal.buildDraft.ended>, "agentId" | "lease">) =>
      ctx.runMutation(internal.buildDraft.ended, { agentId, lease: held, ...args });
    try {
      const setting: Setting | null = await ctx.runQuery(internal.buildDraft.agentSetting, { agentId });
      if (!setting) {
        await end({ outcome: "nothing", reason: "The build brief could not be read", fatal: true });
        return null;
      }
      const brief = setting.kind === "draft" ? await (await ctx.storage.get(setting.briefStorageId))?.text() : undefined;
      if (setting.kind === "draft" && brief === undefined) {
        await end({ outcome: "nothing", reason: "The build brief could not be read", fatal: true });
        return null;
      }
      const route = swarmRoute();
      // A reply another model began is written again rather than carried on.
      const carry = agent.partial && agent.model === route.model ? agent.partial.text : undefined;
      const where = place(agent);
      const detail = { path: agent.path, page: agent.order, total: agent.total, slice: agent.slice, ...(agent.round ? { round: agent.round } : {}) };
      const doing = setting.kind === "gate" ? "Reworking" : "Writing";
      await trace.note({
        phase: carry || agent.thought ? "agent_resume" : "agent_slice",
        label: carry
          ? `Carrying on ${where} from its checkpoint: ${pageName(agent.path)}`
          : agent.thought
            ? `Picking up ${where} from its checkpoint: ${pageName(agent.path)}`
            : agent.role === "frame" && setting.kind === "draft" && !agent.wrote?.shell
              ? agent.total === 1 ? `${doing} your website` : `${doing} ${where}: home, with the header, menu and footer`
              : agent.role === "frame" && setting.kind === "gate"
                ? "Reworking the header, menu, footer and home page"
                : `${doing} ${where}${agent.tries > 0 || agent.problem ? " again" : ""}: ${pageName(agent.path)}`,
        status: "calling",
        detail: { ...detail, model: route.model, ...(carry ? { replyChars: carry.length, continuation: agent.partial?.resumes } : {}), ...(agent.thought ? { thoughtChars: agent.thought.text.length } : {}) },
      });
      const messages = agentMessages(agent, setting, brief, carry);
      const reply = await callProviderSlice(route, messages, deadline, trace, Boolean(carry));
      const stop = sliceStop(reply);
      // The slice ended before the reply wrote a word more: its thinking goes
      // on to the next slice, or, when there was none, the slice counts as one
      // with nothing to show.
      if (reply.sliced && !reply.content.trim()) {
        if (reply.sliced.phase === "waiting" || !reply.sliced.reasoning.trim()) {
          await end({ outcome: "nothing", reason: STOPPED_ANSWERING, stop });
        } else {
          await end({ outcome: "thought", thought: reply.sliced.reasoning, stop });
        }
        return null;
      }
      const text = carry !== undefined ? joinCarry(carry, reply.content) : reply.content;
      const read = readReply(agent, setting, text, reply.cut);
      if (read.outcome === "done") {
        await end({ outcome: "done", wrote: read.wrote });
      } else if (read.outcome === "partial") {
        await end({ outcome: "partial", partial: read.partial, wrote: read.wrote, thought: reply.sliced?.reasoning, stop });
      } else if (reply.sliced && reply.sliced.reasoning.trim() && !read.wrote) {
        // Cut before a block had begun: the thinking is what there is to keep.
        await end({ outcome: "thought", thought: reply.sliced.reasoning, stop });
      } else {
        if (read.problem) {
          await trace.note({
            phase: "agent_unusable",
            label: `${capital(where)} could not be used: ${read.problem.split(/(?<=\.)\s/)[0]}`,
            level: "warn",
            status: "calling",
            detail: { ...detail, replyChars: reply.content.length },
          });
        }
        await end({
          outcome: "nothing",
          reason: read.problem ? "The agent did not return a website" : STOPPED_ANSWERING,
          problem: read.problem,
          wrote: read.wrote,
          restart: read.restart,
          stop,
        });
      }
    } catch (error) {
      // Whatever else stopped the slice, the next one starts from the saved
      // checkpoint; if even that cannot be queued, the rescue starts it.
      console.error("Forge agent slice failed:", describe(error));
      try {
        await end({ outcome: "nothing", reason: describe(error), stop: stopOf(error), fatal: !retryable(error) });
      } catch {
        /* The agent stops beating, and the rescue starts it again. */
      }
    } finally {
      stopBeating();
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Drafts from before the swarm, and agents that went quiet.

export const loadDraft = internalQuery({
  args: { id: v.id("buildDrafts") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

// A draft from before the swarm -- written a page at a time by one step after
// another -- is taken over by agents: the pages it wrote stay written, the page
// it was part way through is carried on, and the rest get an agent each. Its
// reference is narrowed first when it has more pages than a build writes.
export const write = internalAction({
  args: { id: v.id("buildDrafts"), budgetMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const draft = await ctx.runQuery(internal.buildDraft.loadDraft, { id });
    if (!draft || draft.status !== "writing" || draft.agents !== undefined) return null;
    let routes = draft.routes;
    if (routes.length > MAX_PAGES) {
      const design = await ctx.runQuery(internal.siteDesign.forSite, { siteId: draft.siteId });
      if (design && design._id === draft.designId && design.storageId === draft.designStorageId) {
        routes = routes.slice(0, MAX_PAGES);
        try {
          await capReference(ctx, design, routes);
        } catch (error) {
          console.error("Forge could not narrow a draft's reference:", describe(error));
          return null;
        }
      }
    }
    await ctx.runMutation(internal.buildDraft.adopt, { id, routes });
    return null;
  },
});

export const adopt = internalMutation({
  args: { id: v.id("buildDrafts"), routes: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { id, routes }) => {
    const draft = await ctx.db.get(id);
    if (!draft || draft.status !== "writing" || draft.agents !== undefined) return null;
    const design = await ctx.db.get(draft.designId);
    if (design && routes.length < draft.routes.length) {
      await ctx.db.patch(id, { designStorageId: design.storageId });
    }
    const current = { ...draft, designStorageId: design?.storageId ?? draft.designStorageId, routes };
    if (await settle(ctx, current)) return null;
    const now = Date.now();
    const home = draft.pages.find((page) => page.path === "/");
    const ids: Id<"pageAgents">[] = [];
    for (const [index, path] of routes.entries()) {
      const frame = index === 0;
      const written = frame ? home : draft.pages.find((page) => page.path === path);
      const done = frame ? Boolean(draft.shell && home) : Boolean(written);
      const carried = draft.partial?.path === path && !done ? { text: draft.partial.text, resumes: draft.partial.resumes } : undefined;
      const agentId = await ctx.db.insert("pageAgents", newAgent({
        userId: draft.userId,
        runId: draft.runId,
        owner: { draftId: id },
        path,
        role: frame ? "frame" : "page",
        order: index + 1,
        total: routes.length,
        status: done ? "done" : frame || draft.shell ? "writing" : "waiting",
        wrote: frame && draft.shell
          ? { shell: draft.shell, summary: draft.summary, pages: home ? [home] : [] }
          : written ? { pages: [written] } : undefined,
        partial: carried,
      }));
      if (!done && (frame || draft.shell)) ids.push(agentId);
    }
    await ctx.db.patch(id, { routes, agents: routes.length, pages: [], partial: undefined, lease: undefined, beatAt: now, updatedAt: now });
    await recordEvent(ctx, {
      runId: draft.runId, userId: draft.userId, phase: "draft_adopted",
      label: `Handed the rest of your ${routes.length} pages to one agent per page`, status: "calling",
      detail: { total: routes.length, agents: routes.length },
    });
    const owner: Owner = { kind: "draft", draft: { ...current, agents: routes.length } };
    const agents = await agentsOf(ctx, owner);
    if (agents.every((agent) => agent.status === "done")) {
      await handOff(ctx, { ...current, agents: routes.length }, agents);
      return null;
    }
    for (const agentId of ids.slice(0, MAX_PAGES)) await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId });
    return null;
  },
});

// Every half minute (crons.ts). An agent whose slice has gone quiet lost its
// action -- the platform stopped it, or dropped the slice queued after it --
// so the slice is started again from the agent's checkpoint. An agent that
// keeps going quiet without getting anywhere has stalled. A draft from before
// the swarm that went quiet is handed to agents.
export const rescue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const quiet = await ctx.db
      .query("pageAgents")
      .withIndex("by_status_beat", (q) => q.eq("status", "writing").lt("beatAt", now - STEP_QUIET_MS))
      .take(RESCUE_BATCH);
    for (const agent of quiet) {
      const owner = await wanted(ctx, agent);
      if (!owner) {
        await closeAgent(ctx, agent, "cancelled");
        continue;
      }
      const where = place(agent);
      const detail = { path: agent.path, page: agent.order, total: agent.total, slice: agent.slice };
      if (agent.restarts >= MOST_RESTARTS) {
        await recordEvent(ctx, {
          runId: agent.runId, userId: agent.userId, phase: "agent_failed", level: "error",
          label: `${capital(where)} went quiet again after ${agent.restarts} restarts, so the build stopped`,
          detail,
        });
        await failSwarm(ctx, agent, owner, undefined, true);
        continue;
      }
      await ctx.db.patch(agent._id, { lease: undefined, beatAt: now, restarts: agent.restarts + 1, updatedAt: now });
      await recordEvent(ctx, {
        runId: agent.runId, userId: agent.userId, phase: "agent_rescued", level: "warn",
        label: `Started ${where} again from its checkpoint: nothing had been heard from its agent for ${Math.round((now - agent.beatAt) / 1000)}s`,
        status: "calling",
        detail,
      });
      await touch(ctx, owner);
      await ctx.scheduler.runAfter(0, internal.buildDraft.run, { agentId: agent._id });
    }
    const legacy = await ctx.db
      .query("buildDrafts")
      .withIndex("by_status_beat", (q) => q.eq("status", "writing").lt("beatAt", now - STEP_QUIET_MS))
      .take(RESCUE_BATCH);
    for (const draft of legacy) {
      if (draft.agents !== undefined) {
        await ctx.db.patch(draft._id, { beatAt: now });
        continue;
      }
      if (await settle(ctx, draft)) continue;
      if (draft.restarts >= MOST_RESTARTS) {
        await failDraft(ctx, draft, undefined, true);
        continue;
      }
      await ctx.db.patch(draft._id, { lease: undefined, beatAt: now, restarts: draft.restarts + 1, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.buildDraft.write, { id: draft._id });
    }
    return null;
  },
});

// Where recent drafts and their agents got to, for whoever runs the
// deployment: `npx convex run buildDraft:inspect`. Addresses and counts only,
// never a page or the thinking.
export const inspect = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("buildDrafts").order("desc").take(KEEP_DRAFTS);
    return await Promise.all(rows.map(async (row) => {
      const agents = await ctx.db.query("pageAgents").withIndex("by_draft", (q) => q.eq("draftId", row._id)).collect();
      return {
        id: row._id,
        siteName: row.siteName,
        attempt: row.attempt,
        status: row.status,
        routes: row.routes,
        agents: agents.sort((a, b) => a.order - b.order).map(describeAgent),
        error: row.error ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }));
  },
});

// The agents reworking recent layout checks: `npx convex run buildDraft:reworks`.
export const reworks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const gates = await ctx.db.query("designGates").order("desc").take(10);
    return await Promise.all(gates.map(async (gate) => {
      const agents = await ctx.db.query("pageAgents").withIndex("by_gate_round", (q) => q.eq("gateId", gate._id)).collect();
      return {
        id: gate._id,
        siteName: gate.siteName,
        status: gate.status,
        round: gate.round,
        agents: agents.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.order - b.order).map((agent) => ({ round: agent.round, ...describeAgent(agent) })),
      };
    }));
  },
});

function describeAgent(agent: Agent) {
  return {
    path: agent.path,
    role: agent.role,
    status: agent.status,
    model: agent.model,
    slice: agent.slice,
    tries: agent.tries,
    restarts: agent.restarts,
    partial: agent.partial ? { chars: agent.partial.text.length, resumes: agent.partial.resumes } : null,
    thought: agent.thought ? { chars: agent.thought.text.length, slices: agent.thought.slices } : null,
    lastStop: agent.lastStop ?? null,
    error: agent.error ?? null,
    beatAt: agent.beatAt,
  };
}
