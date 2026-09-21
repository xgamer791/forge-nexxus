import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const KEEP_RUNS = 40;
const INSPECT_LIMIT = 20;

const sourceValidator = v.union(
  v.literal("generate"),
  v.literal("onboarding"),
  v.literal("rebuild"),
);
const statusValidator = v.union(
  v.literal("queued"),
  v.literal("started"),
  v.literal("calling"),
  v.literal("images"),
  v.literal("saving"),
  v.literal("complete"),
  v.literal("failed"),
);
const levelValidator = v.union(v.literal("info"), v.literal("warn"), v.literal("error"));
const detailValidator = v.object({
  httpStatus: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  attempt: v.optional(v.number()),
  continuation: v.optional(v.number()),
  truncated: v.optional(v.boolean()),
  tokensAsked: v.optional(v.number()),
  replyChars: v.optional(v.number()),
  promptChars: v.optional(v.number()),
  htmlChars: v.optional(v.number()),
  imageWanted: v.optional(v.number()),
  imageMade: v.optional(v.number()),
  errorClass: v.optional(v.string()),
  host: v.optional(v.string()),
  model: v.optional(v.string()),
  keySet: v.optional(v.boolean()),
  misrouted: v.optional(v.boolean()),
  requestKind: v.optional(v.string()),
  holdStatus: v.optional(v.string()),
  creditAmount: v.optional(v.number()),
  timedOut: v.optional(v.boolean()),
});

const eventValidator = v.object({
  _id: v.id("buildEvents"),
  runId: v.id("buildRuns"),
  at: v.number(),
  phase: v.string(),
  level: levelValidator,
  label: v.string(),
  detail: v.optional(detailValidator),
});

const runValidator = v.object({
  _id: v.id("buildRuns"),
  userId: v.id("users"),
  siteId: v.optional(v.id("sites")),
  conversationId: v.optional(v.id("conversations")),
  onboardingId: v.optional(v.id("siteOnboarding")),
  messageId: v.optional(v.id("messages")),
  holdId: v.optional(v.id("creditHolds")),
  attempt: v.optional(v.number()),
  source: sourceValidator,
  requestKind: v.optional(v.string()),
  status: statusValidator,
  startedAt: v.number(),
  updatedAt: v.number(),
  endedAt: v.optional(v.number()),
  error: v.optional(v.string()),
  errorClass: v.optional(v.string()),
  providerHost: v.optional(v.string()),
  providerModel: v.optional(v.string()),
  providerLabel: v.optional(v.string()),
  keySet: v.optional(v.boolean()),
  misrouted: v.optional(v.boolean()),
  promptChars: v.optional(v.number()),
  htmlChars: v.optional(v.number()),
  imageWanted: v.optional(v.number()),
  imageMade: v.optional(v.number()),
  creditsHeld: v.optional(v.number()),
});

export type EventDetail = {
  httpStatus?: number;
  durationMs?: number;
  attempt?: number;
  continuation?: number;
  truncated?: boolean;
  tokensAsked?: number;
  replyChars?: number;
  promptChars?: number;
  htmlChars?: number;
  imageWanted?: number;
  imageMade?: number;
  errorClass?: string;
  host?: string;
  model?: string;
  keySet?: boolean;
  misrouted?: boolean;
  requestKind?: string;
  holdStatus?: string;
  creditAmount?: number;
  timedOut?: boolean;
};

export type ProviderTrace = {
  note: (input: {
    phase: string;
    label: string;
    level?: "info" | "warn" | "error";
    detail?: EventDetail;
    status?:
      | "queued"
      | "started"
      | "calling"
      | "images"
      | "saving"
      | "complete"
      | "failed";
  }) => Promise<void>;
};

export function classifyError(reason: string) {
  if (/too long|timed out|Timeout|Abort/i.test(reason)) return "timeout";
  if (/empty reply/i.test(reason)) return "empty";
  if (/complete page|did not return a website/i.test(reason)) return "incomplete_page";
  if (/kept refusing/i.test(reason)) return "provider_loop";
  if (/answered \d+/i.test(reason)) return "provider_http";
  if (/could not be reached/i.test(reason)) return "unreachable";
  if (/isn't set up/i.test(reason)) return "unset";
  if (/credit|plan|limit/i.test(reason)) return "credits";
  if (/questions/i.test(reason)) return "questions";
  return "error";
}

type OpenArgs = {
  userId: Id<"users">;
  source: "generate" | "onboarding" | "rebuild";
  status?: "queued" | "started" | "calling" | "images" | "saving" | "complete" | "failed";
  siteId?: Id<"sites">;
  conversationId?: Id<"conversations">;
  onboardingId?: Id<"siteOnboarding">;
  messageId?: Id<"messages">;
  holdId?: Id<"creditHolds">;
  attempt?: number;
  requestKind?: string;
  promptChars?: number;
};

async function pruneRuns(ctx: MutationCtx, userId: Id<"users">) {
  const runs = await ctx.db
    .query("buildRuns")
    .withIndex("by_user_started", (q) => q.eq("userId", userId))
    .collect();
  if (runs.length < KEEP_RUNS) return;
  const extra = runs.length - KEEP_RUNS + 1;
  const finished = runs
    .filter((row) => row.status === "complete" || row.status === "failed")
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const run of finished.slice(0, extra)) {
    const events = await ctx.db
      .query("buildEvents")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    for (const event of events) await ctx.db.delete(event._id);
    await ctx.db.delete(run._id);
  }
}

export async function openRun(ctx: MutationCtx, args: OpenArgs) {
  await pruneRuns(ctx, args.userId);
  const now = Date.now();
  const runId = await ctx.db.insert("buildRuns", {
    userId: args.userId,
    siteId: args.siteId,
    conversationId: args.conversationId,
    onboardingId: args.onboardingId,
    messageId: args.messageId,
    holdId: args.holdId,
    attempt: args.attempt,
    source: args.source,
    requestKind: args.requestKind,
    status: args.status ?? "started",
    startedAt: now,
    updatedAt: now,
    promptChars: args.promptChars,
  });
  await ctx.db.insert("buildEvents", {
    userId: args.userId,
    runId,
    at: now,
    phase: args.status === "queued" ? "queued" : "started",
    level: "info",
    label: args.status === "queued" ? "Build queued" : "Build started",
    detail: {
      requestKind: args.requestKind,
      promptChars: args.promptChars,
    },
  });
  return runId;
}

export async function attachRun(
  ctx: MutationCtx,
  args: {
    runId: Id<"buildRuns">;
    siteId?: Id<"sites">;
    conversationId?: Id<"conversations">;
    onboardingId?: Id<"siteOnboarding">;
    messageId?: Id<"messages">;
    holdId?: Id<"creditHolds">;
    attempt?: number;
    requestKind?: string;
    providerHost?: string;
    providerModel?: string;
    providerLabel?: string;
    keySet?: boolean;
    misrouted?: boolean;
    status?: OpenArgs["status"];
  },
) {
  const row = await ctx.db.get(args.runId);
  if (!row) return;
  let creditsHeld = row.creditsHeld;
  if (args.holdId) {
    const hold = await ctx.db.get(args.holdId);
    if (hold) creditsHeld = hold.amount;
  }
  await ctx.db.patch(args.runId, {
    siteId: args.siteId ?? row.siteId,
    conversationId: args.conversationId ?? row.conversationId,
    onboardingId: args.onboardingId ?? row.onboardingId,
    messageId: args.messageId ?? row.messageId,
    holdId: args.holdId ?? row.holdId,
    attempt: args.attempt ?? row.attempt,
    requestKind: args.requestKind ?? row.requestKind,
    providerHost: args.providerHost ?? row.providerHost,
    providerModel: args.providerModel ?? row.providerModel,
    providerLabel: args.providerLabel ?? row.providerLabel,
    keySet: args.keySet ?? row.keySet,
    misrouted: args.misrouted ?? row.misrouted,
    creditsHeld,
    status: args.status ?? row.status,
    updatedAt: Date.now(),
  });
}

export async function recordEvent(
  ctx: MutationCtx,
  args: {
    runId: Id<"buildRuns">;
    userId: Id<"users">;
    phase: string;
    label: string;
    level?: "info" | "warn" | "error";
    detail?: EventDetail;
    status?: OpenArgs["status"];
  },
) {
  const row = await ctx.db.get(args.runId);
  if (!row || row.userId !== args.userId) return;
  const now = Date.now();
  await ctx.db.insert("buildEvents", {
    userId: args.userId,
    runId: args.runId,
    at: now,
    phase: args.phase,
    level: args.level ?? "info",
    label: args.label,
    detail: args.detail,
  });
  const patch: {
    updatedAt: number;
    status?: OpenArgs["status"];
    htmlChars?: number;
    imageWanted?: number;
    imageMade?: number;
    error?: string;
    errorClass?: string;
  } = { updatedAt: now };
  if (args.status) patch.status = args.status;
  if (args.detail?.htmlChars !== undefined) patch.htmlChars = args.detail.htmlChars;
  if (args.detail?.imageWanted !== undefined) patch.imageWanted = args.detail.imageWanted;
  if (args.detail?.imageMade !== undefined) patch.imageMade = args.detail.imageMade;
  if (args.detail?.errorClass) patch.errorClass = args.detail.errorClass;
  await ctx.db.patch(args.runId, patch);
}

export async function closeRun(
  ctx: MutationCtx,
  args: {
    runId: Id<"buildRuns">;
    status: "complete" | "failed";
    error?: string;
    htmlChars?: number;
    imageWanted?: number;
    imageMade?: number;
  },
) {
  const row = await ctx.db.get(args.runId);
  if (!row || row.status === "complete" || row.status === "failed") return;
  const now = Date.now();
  const errorClass = args.error ? classifyError(args.error) : undefined;
  await ctx.db.patch(args.runId, {
    status: args.status,
    error: args.error,
    errorClass,
    htmlChars: args.htmlChars ?? row.htmlChars,
    imageWanted: args.imageWanted ?? row.imageWanted,
    imageMade: args.imageMade ?? row.imageMade,
    updatedAt: now,
    endedAt: now,
  });
  await ctx.db.insert("buildEvents", {
    userId: row.userId,
    runId: args.runId,
    at: now,
    phase: args.status,
    level: args.status === "failed" ? "error" : "info",
    label: args.status === "failed" ? "Build failed" : "Build finished",
    detail: {
      errorClass,
      htmlChars: args.htmlChars ?? row.htmlChars,
      imageWanted: args.imageWanted ?? row.imageWanted,
      imageMade: args.imageMade ?? row.imageMade,
    },
  });
}

export async function failOpenRun(
  ctx: MutationCtx,
  args: { onboardingId: Id<"siteOnboarding">; attempt: number; error: string },
) {
  const row = await ctx.db
    .query("buildRuns")
    .withIndex("by_onboarding_attempt", (q) =>
      q.eq("onboardingId", args.onboardingId).eq("attempt", args.attempt),
    )
    .first();
  if (!row) return;
  await closeRun(ctx, { runId: row._id, status: "failed", error: args.error });
}

export function providerTrace(
  ctx: ActionCtx,
  runId: Id<"buildRuns">,
  userId: Id<"users">,
): ProviderTrace {
  return {
    note: async (input) => {
      try {
        await ctx.runMutation(internal.diagnostics.record, {
          runId,
          userId,
          phase: input.phase,
          label: input.label,
          level: input.level,
          detail: input.detail,
          status: input.status,
        });
      } catch (error) {
        console.error("Forge could not record a build diagnostic:", error);
      }
    },
  };
}

const internalRecord = internalMutation({
  args: {
    runId: v.id("buildRuns"),
    userId: v.id("users"),
    phase: v.string(),
    label: v.string(),
    level: v.optional(levelValidator),
    detail: v.optional(detailValidator),
    status: v.optional(statusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordEvent(ctx, args);
    return null;
  },
});

export const open = internalMutation({
  args: {
    userId: v.id("users"),
    source: sourceValidator,
    status: v.optional(statusValidator),
    siteId: v.optional(v.id("sites")),
    conversationId: v.optional(v.id("conversations")),
    onboardingId: v.optional(v.id("siteOnboarding")),
    messageId: v.optional(v.id("messages")),
    holdId: v.optional(v.id("creditHolds")),
    attempt: v.optional(v.number()),
    requestKind: v.optional(v.string()),
    promptChars: v.optional(v.number()),
  },
  returns: v.id("buildRuns"),
  handler: async (ctx, args) => await openRun(ctx, args),
});

export const attach = internalMutation({
  args: {
    runId: v.id("buildRuns"),
    siteId: v.optional(v.id("sites")),
    conversationId: v.optional(v.id("conversations")),
    onboardingId: v.optional(v.id("siteOnboarding")),
    messageId: v.optional(v.id("messages")),
    holdId: v.optional(v.id("creditHolds")),
    attempt: v.optional(v.number()),
    requestKind: v.optional(v.string()),
    providerHost: v.optional(v.string()),
    providerModel: v.optional(v.string()),
    providerLabel: v.optional(v.string()),
    keySet: v.optional(v.boolean()),
    misrouted: v.optional(v.boolean()),
    status: v.optional(statusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await attachRun(ctx, args);
    return null;
  },
});

export const record = internalRecord;

export const close = internalMutation({
  args: {
    runId: v.id("buildRuns"),
    status: v.union(v.literal("complete"), v.literal("failed")),
    error: v.optional(v.string()),
    htmlChars: v.optional(v.number()),
    imageWanted: v.optional(v.number()),
    imageMade: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeRun(ctx, args);
    return null;
  },
});

export const failOpen = internalMutation({
  args: {
    onboardingId: v.id("siteOnboarding"),
    attempt: v.number(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await failOpenRun(ctx, args);
    return null;
  },
});

function publicRun(row: {
  _id: Id<"buildRuns">;
  userId: Id<"users">;
  siteId?: Id<"sites">;
  conversationId?: Id<"conversations">;
  onboardingId?: Id<"siteOnboarding">;
  messageId?: Id<"messages">;
  holdId?: Id<"creditHolds">;
  attempt?: number;
  source: "generate" | "onboarding" | "rebuild";
  requestKind?: string;
  status:
    | "queued"
    | "started"
    | "calling"
    | "images"
    | "saving"
    | "complete"
    | "failed";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: string;
  errorClass?: string;
  providerHost?: string;
  providerModel?: string;
  providerLabel?: string;
  keySet?: boolean;
  misrouted?: boolean;
  promptChars?: number;
  htmlChars?: number;
  imageWanted?: number;
  imageMade?: number;
  creditsHeld?: number;
}) {
  return {
    _id: row._id,
    userId: row.userId,
    siteId: row.siteId,
    conversationId: row.conversationId,
    onboardingId: row.onboardingId,
    messageId: row.messageId,
    holdId: row.holdId,
    attempt: row.attempt,
    source: row.source,
    requestKind: row.requestKind,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
    error: row.error,
    errorClass: row.errorClass,
    providerHost: row.providerHost,
    providerModel: row.providerModel,
    providerLabel: row.providerLabel,
    keySet: row.keySet,
    misrouted: row.misrouted,
    promptChars: row.promptChars,
    htmlChars: row.htmlChars,
    imageWanted: row.imageWanted,
    imageMade: row.imageMade,
    creditsHeld: row.creditsHeld,
  };
}

function publicEvent(row: {
  _id: Id<"buildEvents">;
  runId: Id<"buildRuns">;
  at: number;
  phase: string;
  level: "info" | "warn" | "error";
  label: string;
  detail?: EventDetail;
}) {
  return {
    _id: row._id,
    runId: row.runId,
    at: row.at,
    phase: row.phase,
    level: row.level,
    label: row.label,
    detail: row.detail,
  };
}

async function eventsFor(ctx: QueryCtx, runId: Id<"buildRuns">) {
  const events = await ctx.db
    .query("buildEvents")
    .withIndex("by_run_at", (q) => q.eq("runId", runId))
    .collect();
  return events.map(publicEvent);
}

async function runsForUser(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("buildRuns")
    .withIndex("by_user_started", (q) => q.eq("userId", userId))
    .order("desc")
    .take(12);
}

function pickLatest<T extends { status: string }>(runs: T[]) {
  return runs.find((row) => row.status !== "complete" && row.status !== "failed") ?? runs[0] ?? null;
}

const mineReturn = v.union(
  v.null(),
  v.object({
    latest: v.union(runValidator, v.null()),
    active: v.union(runValidator, v.null()),
    events: v.array(eventValidator),
    recent: v.array(runValidator),
  }),
);

// What the signed-in member — and anyone asking on their behalf — can see
// about the building agent. Host and model names are safe; keys and prompts
// never leave the server.
export const mine = query({
  args: {},
  returns: mineReturn,
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const runs = (await runsForUser(ctx, userId)).map(publicRun);
    const latest = pickLatest(runs);
    const active = runs.find((row) => row.status !== "complete" && row.status !== "failed") ?? null;
    return {
      latest,
      active,
      events: latest ? await eventsFor(ctx, latest._id) : [],
      recent: runs,
    };
  },
});

export const inspectRecent = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      run: runValidator,
      email: v.union(v.string(), v.null()),
      events: v.array(eventValidator),
    }),
  ),
  handler: async (ctx) => {
    const runs = await ctx.db.query("buildRuns").withIndex("by_started").order("desc").take(INSPECT_LIMIT);
    return await Promise.all(
      runs.map(async (row) => {
        const user = await ctx.db.get(row.userId);
        return {
          run: publicRun(row),
          email: user && "email" in user ? (user.email ?? null) : null,
          events: await eventsFor(ctx, row._id),
        };
      }),
    );
  },
});

export const findOpen = internalQuery({
  args: { onboardingId: v.id("siteOnboarding"), attempt: v.number() },
  returns: v.union(v.id("buildRuns"), v.null()),
  handler: async (ctx, { onboardingId, attempt }) => {
    const row = await ctx.db
      .query("buildRuns")
      .withIndex("by_onboarding_attempt", (q) => q.eq("onboardingId", onboardingId).eq("attempt", attempt))
      .first();
    if (!row || row.status === "complete" || row.status === "failed") return null;
    return row._id;
  },
});

export const inspectUser = internalQuery({
  args: { userId: v.id("users") },
  returns: v.object({
    latest: v.union(runValidator, v.null()),
    active: v.union(runValidator, v.null()),
    events: v.array(eventValidator),
    recent: v.array(runValidator),
  }),
  handler: async (ctx, { userId }) => {
    const runs = (await runsForUser(ctx, userId)).map(publicRun);
    const latest = pickLatest(runs);
    return {
      latest,
      active: runs.find((row) => row.status !== "complete" && row.status !== "failed") ?? null,
      events: latest ? await eventsFor(ctx, latest._id) : [],
      recent: runs,
    };
  },
});
