import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireMemberId } from "./access";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  PLANS,
  REQUEST_COSTS,
  REQUEST_LABELS,
  TOP_UPS,
  planFor,
  planKey,
  requestKind,
  topUpFor,
  type PlanKey,
  type RequestKind,
} from "./plans";

const HISTORY_LIMIT = 50;

// A period is one calendar month, the way a card subscription renews. The day
// is clamped, so a plan started on the 31st renews on the 28th in February.
// Stripe's own period boundaries take over once checkout is wired up.
export function addMonth(from: number) {
  const date = new Date(from);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

type Balance = {
  planKey: PlanKey;
  periodStart: number;
  periodEnd: number;
  credits: number;
  reserved: number;
  granted: number;
  cancelAtPeriodEnd: boolean;
};

function opening(key: PlanKey, now: number): Balance {
  return {
    planKey: key,
    periodStart: now,
    periodEnd: addMonth(now),
    credits: planFor(key).monthlyCredits,
    reserved: 0,
    granted: planFor(key).monthlyCredits,
    cancelAtPeriodEnd: false,
  };
}

// Where a subscription stands at `now`. A period that has ended is reported as
// it will be once a mutation rolls it forward: the leftover has expired, a
// scheduled downgrade has happened, and the new allowance is in place.
export function projected(sub: Balance, now: number): Balance {
  if (now < sub.periodEnd) return sub;
  let periodStart = sub.periodEnd;
  let periodEnd = addMonth(periodStart);
  while (now >= periodEnd) {
    periodStart = periodEnd;
    periodEnd = addMonth(periodStart);
  }
  const key = sub.cancelAtPeriodEnd ? "free" : sub.planKey;
  return {
    planKey: key,
    periodStart,
    periodEnd,
    credits: planFor(key).monthlyCredits,
    reserved: sub.reserved,
    granted: planFor(key).monthlyCredits,
    cancelAtPeriodEnd: false,
  };
}

export async function subscriptionFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

// The plan a member is on right now, for entitlement checks. Reads only, so a
// query can use it as well as a mutation.
export async function currentPlan(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const sub = await subscriptionFor(ctx, userId);
  return planFor(sub ? projected(sub, Date.now()).planKey : "free");
}

async function record(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: Doc<"creditLedger">["kind"],
  amount: number,
  balanceAfter: number,
  note: string,
  createdAt: number,
) {
  await ctx.db.insert("creditLedger", { userId, kind, amount, balanceAfter, note, createdAt });
}

// Brings a member's row up to date and returns it: creates a free subscription
// for one who has none, and rolls an ended period forward.
export async function ensureCurrent(ctx: MutationCtx, userId: Id<"users">, now = Date.now()) {
  const existing = await subscriptionFor(ctx, userId);
  if (!existing) {
    const fresh = opening("free", now);
    const id = await ctx.db.insert("subscriptions", { userId, ...fresh, updatedAt: now });
    await record(ctx, userId, "grant", fresh.credits, fresh.credits, "Free plan credits", now);
    return (await ctx.db.get(id))!;
  }
  if (now < existing.periodEnd) return existing;
  const next = projected(existing, now);
  if (existing.credits > 0) {
    await record(ctx, userId, "expire", -existing.credits, 0, "Period ended", now);
  }
  await record(
    ctx,
    userId,
    "grant",
    next.credits,
    next.credits,
    `${planFor(next.planKey).name} plan credits`,
    now + 1,
  );
  await ctx.db.patch(existing._id, { ...next, updatedAt: now });
  return (await ctx.db.get(existing._id))!;
}

async function memberOrNull(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get(userId) : null;
  return user && !user.isAnonymous ? user : null;
}

// Null for guests and the signed-out, which hides the credits card.
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await memberOrNull(ctx);
    if (!user) return null;
    const now = Date.now();
    const stored = await subscriptionFor(ctx, user._id);
    const balance = stored ? projected(stored, now) : opening("free", now);
    return {
      plan: planFor(balance.planKey),
      credits: balance.credits,
      reserved: balance.reserved,
      available: Math.max(0, balance.credits - balance.reserved),
      // What this period started with plus its top-ups: the meter's full mark.
      granted: balance.granted,
      periodStart: balance.periodStart,
      periodEnd: balance.periodEnd,
      cancelAtPeriodEnd: balance.cancelAtPeriodEnd,
    };
  },
});

// The pricing page reads this, so the client never carries its own copy.
export const catalog = query({
  args: {},
  handler: async () => ({ plans: PLANS, topUps: TOP_UPS, requestCosts: REQUEST_COSTS }),
});

export const history = query({
  args: {},
  handler: async (ctx) => {
    const user = await memberOrNull(ctx);
    if (!user) return [];
    const entries = await ctx.db
      .query("creditLedger")
      .withIndex("by_user_created", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(HISTORY_LIMIT);
    return entries.map(({ userId: _owner, ...entry }) => entry);
  },
});

// Moves to the free plan when the paid period ends; nothing is lost before then.
export const cancel = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireMemberId(ctx);
    const sub = await ensureCurrent(ctx, userId);
    if (sub.planKey === "free") throw new ConvexError("You're already on the free plan");
    await ctx.db.patch(sub._id, { cancelAtPeriodEnd: true, updatedAt: Date.now() });
  },
});

export const resume = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireMemberId(ctx);
    const sub = await ensureCurrent(ctx, userId);
    if (!sub.cancelAtPeriodEnd) return;
    await ctx.db.patch(sub._id, { cancelAtPeriodEnd: false, updatedAt: Date.now() });
  },
});

// Starts a purchase. Stripe Checkout goes here: create a session for the plan's
// or the pack's price with the user id in its metadata and return its URL; the
// webhook in http.ts then calls grantPlan or grantTopUp. Until the keys are
// set, the app is told plainly that payments are not open.
export const checkout = action({
  args: { plan: v.optional(planKey), topUp: v.optional(v.string()) },
  handler: async (ctx, { plan, topUp }): Promise<{ url: string }> => {
    const me = await ctx.runQuery(api.users.me, {});
    if (!me || me.isAnonymous) throw new ConvexError("Sign in to change your plan");
    if (plan === "free") throw new ConvexError("Downgrading happens from Plan & credits");
    if (!plan && !topUpFor(topUp ?? "")) throw new ConvexError("Choose a plan or a credit pack");
    throw new ConvexError("Payments aren't open yet. Plans and top-ups will be available soon.");
  },
});

async function resolveUserId(
  ctx: MutationCtx,
  args: { userId?: Id<"users">; email?: string },
) {
  if (args.userId) return args.userId;
  const email = args.email?.trim().toLowerCase();
  const user = email
    ? await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first()
    : null;
  if (!user) throw new ConvexError("No account with that email");
  return user._id;
}

export const ensure = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) return;
    await ensureCurrent(ctx, userId);
  },
});

// Holds a request's credits before it runs. The check and the hold happen in
// one transaction, so two requests racing for the last credit cannot both pass.
export const reserve = internalMutation({
  args: { userId: v.id("users"), requestKind },
  handler: async (ctx, { userId, requestKind: kind }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.isAnonymous) throw new ConvexError("Sign in to build");
    const now = Date.now();
    const sub = await ensureCurrent(ctx, userId, now);
    const amount = REQUEST_COSTS[kind];
    if (sub.credits - sub.reserved < amount) throw new ConvexError("Out of credits");
    const holdId = await ctx.db.insert("creditHolds", {
      userId,
      requestKind: kind,
      amount,
      status: "held",
      createdAt: now,
    });
    await ctx.db.patch(sub._id, { reserved: sub.reserved + amount, updatedAt: now });
    return { holdId, amount };
  },
});

// Turns a hold into a spend. A request never costs more than it held: the hold
// is the promise made to the user when it started.
export const settle = internalMutation({
  args: { holdId: v.id("creditHolds"), amount: v.optional(v.number()) },
  handler: async (ctx, { holdId, amount }) => {
    const hold = await ctx.db.get(holdId);
    if (!hold || hold.status !== "held") return;
    const now = Date.now();
    const sub = await ensureCurrent(ctx, hold.userId, now);
    const spent = Math.min(hold.amount, Math.max(0, Math.round(amount ?? hold.amount)));
    const credits = Math.max(0, sub.credits - spent);
    await ctx.db.patch(sub._id, {
      credits,
      reserved: Math.max(0, sub.reserved - hold.amount),
      updatedAt: now,
    });
    await ctx.db.patch(holdId, { status: "settled" });
    if (spent > 0) {
      const label = REQUEST_LABELS[hold.requestKind as RequestKind] ?? hold.requestKind;
      await record(ctx, hold.userId, "spend", -spent, credits, label, now);
    }
  },
});

// Gives a hold back, for a request that failed before it did any work.
export const release = internalMutation({
  args: { holdId: v.id("creditHolds") },
  handler: async (ctx, { holdId }) => {
    const hold = await ctx.db.get(holdId);
    if (!hold || hold.status !== "held") return;
    const now = Date.now();
    const sub = await ensureCurrent(ctx, hold.userId, now);
    await ctx.db.patch(sub._id, {
      reserved: Math.max(0, sub.reserved - hold.amount),
      updatedAt: now,
    });
    await ctx.db.patch(holdId, { status: "released" });
  },
});

// Puts a member on a plan from now: a fresh period opens with the plan's
// allowance, and whatever the old period had left comes along. Run it from the
// Convex dashboard until Stripe's webhook calls it.
export const grantPlan = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    plan: planKey,
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const now = Date.now();
    const sub = await ensureCurrent(ctx, userId, now);
    const next = opening(args.plan, now);
    const credits = sub.credits + next.credits;
    await ctx.db.patch(sub._id, {
      ...next,
      credits,
      granted: credits,
      reserved: sub.reserved,
      stripeCustomerId: args.stripeCustomerId ?? sub.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId ?? sub.stripeSubscriptionId,
      updatedAt: now,
    });
    await record(ctx, userId, "grant", next.credits, credits, `${planFor(args.plan).name} plan credits`, now);
  },
});

// Adds a credit pack, or an arbitrary amount, to the current period.
export const grantTopUp = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    pack: v.optional(v.string()),
    credits: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const pack = args.pack ? topUpFor(args.pack) : null;
    if (args.pack && !pack) throw new ConvexError("That credit pack does not exist");
    const credits = Math.round(pack?.credits ?? args.credits ?? 0);
    if (credits <= 0) throw new ConvexError("A top-up needs a pack or a credit amount");
    const now = Date.now();
    const sub = await ensureCurrent(ctx, userId, now);
    const balance = sub.credits + credits;
    await ctx.db.patch(sub._id, { credits: balance, granted: sub.granted + credits, updatedAt: now });
    await record(ctx, userId, "topup", credits, balance, args.note ?? `${credits} credit top-up`, now);
  },
});
