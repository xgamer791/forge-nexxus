import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireMemberId } from "./access";
import { isAdminEmail } from "./admins";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { createCheckoutSession, createPortalSession, stripeRequest } from "./stripe";
import {
  PLANS,
  REQUEST_COSTS,
  REQUEST_LABELS,
  TOP_UPS,
  incomingPlanKey,
  normalizePlanKey,
  planFor,
  requestKind,
  topPlan,
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

// A period's allowance: zero on an unlimited plan, where nothing is counted.
function allowance(key: PlanKey) {
  return planFor(key).monthlyCredits ?? 0;
}

function opening(key: PlanKey, now: number): Balance {
  return {
    planKey: key,
    periodStart: now,
    periodEnd: addMonth(now),
    credits: allowance(key),
    reserved: 0,
    granted: allowance(key),
    cancelAtPeriodEnd: false,
  };
}

// Where a subscription stands at `now`. A period that has ended is reported as
// it will be once a mutation rolls it forward: the leftover has expired, a
// scheduled downgrade has happened, and the new allowance is in place.
export function projected(sub: Omit<Balance, "planKey"> & { planKey: string }, now: number): Balance {
  const stored = normalizePlanKey(sub.planKey);
  if (now < sub.periodEnd) {
    return {
      planKey: stored,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      credits: sub.credits,
      reserved: sub.reserved,
      granted: sub.granted,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
  }
  let periodStart = sub.periodEnd;
  let periodEnd = addMonth(periodStart);
  while (now >= periodEnd) {
    periodStart = periodEnd;
    periodEnd = addMonth(periodStart);
  }
  const key = sub.cancelAtPeriodEnd ? "free" : stored;
  return {
    planKey: key,
    periodStart,
    periodEnd,
    credits: allowance(key),
    reserved: sub.reserved,
    granted: allowance(key),
    cancelAtPeriodEnd: false,
  };
}

export async function subscriptionFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

// The row a Stripe subscription or customer id belongs to.
export async function subscriptionByStripe(
  ctx: QueryCtx | MutationCtx,
  ids: { subscriptionId?: string; customerId?: string },
) {
  const rows = await ctx.db.query("subscriptions").collect();
  return (
    rows.find((row) => ids.subscriptionId && row.stripeSubscriptionId === ids.subscriptionId) ??
    rows.find((row) => ids.customerId && row.stripeCustomerId === ids.customerId) ??
    null
  );
}

// The plan a member is on right now, for entitlement checks. Reads only, so a
// query can use it as well as a mutation.
export async function currentPlan(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const sub = await subscriptionFor(ctx, userId);
  const stored = planFor(sub ? projected(sub, Date.now()).planKey : "free");
  // Every mutation that touches a subscription puts an admin back on the top
  // plan, but only a mutation can write one. Read the same answer here, or the
  // gates refuse what the rule grants: an admin whose stored row had not been
  // rolled onto the top plan yet could take an address (Starter carries one)
  // and then be told a custom domain was not on their plan, by the deployment
  // that holds them on the plan which has it.
  const user = await ctx.db.get(userId);
  return isAdminEmail(user?.email) ? topPlan() : stored;
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

// Brings a member's row up to date and returns it: creates an unpaid
// subscription for one who has none, and rolls an ended period forward.
export async function ensureCurrent(ctx: MutationCtx, userId: Id<"users">, now = Date.now()) {
  return await holdAdminPlan(ctx, userId, await rolledForward(ctx, userId, now), now);
}

// An admin account belongs on the top plan, and stays there: every path that
// touches a subscription comes through here, so a period rolling over, a
// cancelled card or a Stripe downgrade all land back on it.
async function holdAdminPlan(
  ctx: MutationCtx,
  userId: Id<"users">,
  sub: Doc<"subscriptions">,
  now: number,
) {
  const user = await ctx.db.get(userId);
  const top = topPlan();
  if (!isAdminEmail(user?.email) || normalizePlanKey(sub.planKey) === top.key) return sub;
  await setPlan(ctx, userId, sub, top.key, { now });
  return (await ctx.db.get(sub._id))!;
}

async function rolledForward(ctx: MutationCtx, userId: Id<"users">, now: number) {
  const existing = await subscriptionFor(ctx, userId);
  if (!existing) {
    // A member who has not checked out yet is unpaid. A one-time welcome
    // grant sits on top of whatever that period allows.
    const plan = planFor("free");
    const fresh = opening("free", now);
    const credits = fresh.credits + plan.signupCredits;
    const id = await ctx.db.insert("subscriptions", {
      userId,
      ...fresh,
      credits,
      granted: credits,
      updatedAt: now,
    });
    if (credits > 0) await record(ctx, userId, "grant", credits, credits, "Welcome credits", now);
    return (await ctx.db.get(id))!;
  }
  if (now < existing.periodEnd) {
    const canonical = normalizePlanKey(existing.planKey);
    if (canonical !== existing.planKey) {
      await ctx.db.patch(existing._id, { planKey: canonical, updatedAt: now });
      return (await ctx.db.get(existing._id))!;
    }
    return existing;
  }
  const next = projected(existing, now);
  if (existing.credits > 0) {
    await record(ctx, userId, "expire", -existing.credits, 0, "Period ended", now);
  }
  if (next.credits > 0) {
    await record(
      ctx,
      userId,
      "grant",
      next.credits,
      next.credits,
      `${planFor(next.planKey).name} plan credits`,
      now + 1,
    );
  }
  await ctx.db.patch(existing._id, { ...next, updatedAt: now });
  return (await ctx.db.get(existing._id))!;
}

// The cheapest plan that has an entitlement, for messages that point at it.
function cheapestWith(entitlement: "topUps" | "customDomains") {
  return PLANS.find((plan) => plan[entitlement])?.name ?? "Pro";
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
    const plan = isAdminEmail(user.email) ? topPlan() : planFor(balance.planKey);
    const unlimited = plan.monthlyCredits === null;
    return {
      plan,
      unlimited,
      credits: balance.credits,
      reserved: balance.reserved,
      // Null on an unlimited plan: there is no number to run out of.
      available: unlimited ? null : Math.max(0, balance.credits - balance.reserved),
      // Whether Stripe knows this member, which is what the billing portal needs.
      billingAccount: Boolean(stored?.stripeCustomerId),
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

// What has been taken in and how much of it is the providers' to spend, for
// whoever runs the deployment: `npx convex run billing:funding`. Cash is never
// answered to a browser, so this is an internal query and stays one.
export const funding = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("payments").collect();
    const total = rows.reduce(
      (sum, row) => ({
        paidCents: sum.paidCents + row.paidCents,
        apiCents: sum.apiCents + row.apiCents,
        forgeCents: sum.forgeCents + row.forgeCents,
      }),
      { paidCents: 0, apiCents: 0, forgeCents: 0 },
    );
    return { payments: rows.length, ...total };
  },
});

// What checkout, cancelling and the portal need to know about the caller.
export const checkoutContext = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await memberOrNull(ctx);
    if (!user) return null;
    const stored = await subscriptionFor(ctx, user._id);
    const key = stored ? projected(stored, Date.now()).planKey : "free";
    return {
      userId: user._id,
      email: user.email ?? null,
      planKey: key,
      plan: planFor(key),
      stripeCustomerId: stored?.stripeCustomerId ?? null,
      stripeSubscriptionId: stored?.stripeSubscriptionId ?? null,
      cancelAtPeriodEnd: stored?.cancelAtPeriodEnd ?? false,
    };
  },
});

export const setCancel = internalMutation({
  args: { userId: v.id("users"), cancel: v.boolean() },
  handler: async (ctx, { userId, cancel: cancelAtPeriodEnd }) => {
    const sub = await ensureCurrent(ctx, userId);
    if (cancelAtPeriodEnd && sub.planKey === "free") throw new ConvexError("You're already off a paid plan");
    await ctx.db.patch(sub._id, { cancelAtPeriodEnd, updatedAt: Date.now() });
  },
});

// Leaves the paid plan when the period ends; nothing is lost before then.
// A plan Stripe is billing is told the same thing, so the two agree.
export const cancel = action({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.runQuery(internal.billing.checkoutContext, {});
    if (!me) throw new ConvexError("Sign in to change your plan");
    if (me.planKey === "free") throw new ConvexError("You're already off a paid plan");
    if (me.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      await stripeRequest(`/subscriptions/${me.stripeSubscriptionId}`, { cancel_at_period_end: "true" });
    }
    await ctx.runMutation(internal.billing.setCancel, { userId: me.userId, cancel: true });
  },
});

export const resume = action({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.runQuery(internal.billing.checkoutContext, {});
    if (!me) throw new ConvexError("Sign in to change your plan");
    if (!me.cancelAtPeriodEnd) return;
    if (me.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      await stripeRequest(`/subscriptions/${me.stripeSubscriptionId}`, { cancel_at_period_end: "false" });
    }
    await ctx.runMutation(internal.billing.setCancel, { userId: me.userId, cancel: false });
  },
});

// Stripe's own billing page: payment method, invoices, and the address.
export const portal = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const me = await ctx.runQuery(internal.billing.checkoutContext, {});
    if (!me) throw new ConvexError("Sign in to manage billing");
    if (!me.stripeCustomerId) throw new ConvexError("There's no billing account yet");
    return await createPortalSession(me.stripeCustomerId);
  },
});

// Starts a purchase. Stripe Checkout goes here: create a session for the plan's
// or the pack's price with the user id in its metadata and return its URL; the
// webhook in http.ts then calls grantPlan or grantTopUp. Until the keys are
// set, the app is told plainly that payments are not open.
export const checkout = action({
  args: {
    plan: v.optional(incomingPlanKey),
    interval: v.optional(v.union(v.literal("month"), v.literal("year"))),
    topUp: v.optional(v.string()),
  },
  handler: async (ctx, { plan, interval, topUp }): Promise<{ url: string }> => {
    const me = await ctx.runQuery(internal.billing.checkoutContext, {});
    if (!me) throw new ConvexError("Sign in to change your plan");
    const chosen = plan ? normalizePlanKey(plan) : undefined;
    if (plan === "free") throw new ConvexError("Cancelling happens from Plan & credits");
    if (!chosen && !topUpFor(topUp ?? "")) throw new ConvexError("Choose a plan or a credit pack");
    if (!chosen && topUp && !me.plan.topUps) {
      throw new ConvexError(`Extra credits come with the ${cheapestWith("topUps")} plan`);
    }
    if (chosen && chosen === me.planKey) throw new ConvexError("You're already on that plan");
    return await createCheckoutSession({
      userId: me.userId,
      email: me.email,
      stripeCustomerId: me.stripeCustomerId,
      plan: chosen,
      interval,
      pack: topUp,
    });
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

// What a request of this kind would need and whether the balance covers it,
// without taking a hold or throwing. It lets a caller offer something cheaper
// instead of refusing outright. An unlimited plan always covers it; a guest
// never does, so the caller still reaches the "Sign in to build" refusal.
export async function creditCheck(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: RequestKind,
  now = Date.now(),
): Promise<{ affordable: boolean; needed: number; available: number | null }> {
  const needed = REQUEST_COSTS[kind];
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) return { affordable: false, needed, available: 0 };
  const sub = await ensureCurrent(ctx, userId, now);
  if (planFor(sub.planKey).monthlyCredits === null) return { affordable: true, needed, available: null };
  const available = Math.max(0, sub.credits - sub.reserved);
  return { affordable: available >= needed, needed, available };
}

// Holds a request's credits before it runs. The check and the hold happen in
// one transaction, so two requests racing for the last credit cannot both pass.
export async function holdCredits(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: RequestKind,
  now = Date.now(),
) {
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) throw new ConvexError("Sign in to build");
  const sub = await ensureCurrent(ctx, userId, now);
  const amount = REQUEST_COSTS[kind];
  const unlimited = planFor(sub.planKey).monthlyCredits === null;
  const available = sub.credits - sub.reserved;
  if (!unlimited && available < amount) {
    throw new ConvexError(
      `Out of credits: this needs ${amount} and you have ${Math.max(0, available)}. ` +
        (sub.planKey === "free" ? "Upgrade to start building." : "Top up or upgrade to keep building."),
    );
  }
  const holdId = await ctx.db.insert("creditHolds", {
    userId,
    requestKind: kind,
    amount,
    status: "held",
    createdAt: now,
  });
  if (!unlimited) await ctx.db.patch(sub._id, { reserved: sub.reserved + amount, updatedAt: now });
  return { holdId, amount };
}

// Turns a hold into a spend. A request never costs more than it held: the hold
// is the promise made to the user when it started. `kind` renames the spend for
// the ledger when the request turned out to be something cheaper than the hold
// was taken for -- a prompt held as a build that came back as a conversation.
export async function settleHold(
  ctx: MutationCtx,
  holdId: Id<"creditHolds">,
  amount?: number,
  now = Date.now(),
  kind?: RequestKind,
) {
  const hold = await ctx.db.get(holdId);
  if (!hold || hold.status !== "held") return;
  const sub = await ensureCurrent(ctx, hold.userId, now);
  const unlimited = planFor(sub.planKey).monthlyCredits === null;
  const spent = Math.min(hold.amount, Math.max(0, Math.round(amount ?? hold.amount)));
  // An unlimited plan still writes the spend down, so Usage shows the work,
  // but the balance it never drew on stays where it was.
  const credits = unlimited ? sub.credits : Math.max(0, sub.credits - spent);
  if (!unlimited) {
    await ctx.db.patch(sub._id, {
      credits,
      reserved: Math.max(0, sub.reserved - hold.amount),
      updatedAt: now,
    });
  }
  await ctx.db.patch(holdId, { status: "settled" });
  if (spent > 0) {
    const label = REQUEST_LABELS[kind ?? (hold.requestKind as RequestKind)] ?? hold.requestKind;
    await record(ctx, hold.userId, "spend", -spent, credits, label, now);
  }
}

// Gives a hold back, for a request that failed before it did any work.
export async function releaseHold(ctx: MutationCtx, holdId: Id<"creditHolds">, now = Date.now()) {
  const hold = await ctx.db.get(holdId);
  if (!hold || hold.status !== "held") return;
  const sub = await ensureCurrent(ctx, hold.userId, now);
  if (planFor(sub.planKey).monthlyCredits !== null) {
    await ctx.db.patch(sub._id, {
      reserved: Math.max(0, sub.reserved - hold.amount),
      updatedAt: now,
    });
  }
  await ctx.db.patch(holdId, { status: "released" });
}

export const reserve = internalMutation({
  args: { userId: v.id("users"), requestKind },
  handler: async (ctx, { userId, requestKind: kind }) => await holdCredits(ctx, userId, kind),
});

export const settle = internalMutation({
  args: {
    holdId: v.id("creditHolds"),
    amount: v.optional(v.number()),
    requestKind: v.optional(requestKind),
  },
  handler: async (ctx, { holdId, amount, requestKind: kind }) => {
    await settleHold(ctx, holdId, amount, undefined, kind);
  },
});

export const release = internalMutation({
  args: { holdId: v.id("creditHolds") },
  handler: async (ctx, { holdId }) => {
    await releaseHold(ctx, holdId);
  },
});

// Puts a member on a plan from now: a fresh period opens with the plan's
// allowance, and whatever the old period had left comes along. Run it from the
// Convex dashboard until Stripe's webhook calls it.
export const grantPlan = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    plan: incomingPlanKey,
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await applyPlan(ctx, userId, normalizePlanKey(args.plan), {
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
    });
  },
});

// Puts a member on a plan. By default a fresh period opens now and whatever
// the old period had left comes along; a renewal expires the leftover first,
// and Stripe's own period boundaries are used when it supplies them.
export async function applyPlan(
  ctx: MutationCtx,
  userId: Id<"users">,
  plan: PlanKey,
  options: {
    now?: number;
    periodStart?: number | null;
    periodEnd?: number | null;
    renewal?: boolean;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string | null;
  } = {},
) {
  const now = options.now ?? Date.now();
  const sub = await ensureCurrent(ctx, userId, now);
  await setPlan(ctx, userId, sub, plan, options);
}

// The plan change itself, against a subscription the caller already has.
async function setPlan(
  ctx: MutationCtx,
  userId: Id<"users">,
  sub: Doc<"subscriptions">,
  plan: PlanKey,
  options: {
    now?: number;
    periodStart?: number | null;
    periodEnd?: number | null;
    renewal?: boolean;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string | null;
  } = {},
) {
  const now = options.now ?? Date.now();
  const next = opening(normalizePlanKey(plan), options.periodStart ?? now);
  if (options.periodEnd) next.periodEnd = options.periodEnd;
  let carried = sub.credits;
  if (options.renewal && sub.credits > 0) {
    await record(ctx, userId, "expire", -sub.credits, 0, "Period ended", now);
    carried = 0;
  }
  const credits = carried + next.credits;
  await ctx.db.patch(sub._id, {
    ...next,
    credits,
    granted: credits,
    reserved: sub.reserved,
    stripeCustomerId: options.stripeCustomerId ?? sub.stripeCustomerId,
    stripeSubscriptionId:
      options.stripeSubscriptionId === null
        ? undefined
        : (options.stripeSubscriptionId ?? sub.stripeSubscriptionId),
    updatedAt: now,
  });
  if (next.credits > 0) {
    await record(ctx, userId, "grant", next.credits, credits, `${planFor(plan).name} plan credits`, now + 1);
  }
}

export async function creditTopUp(
  ctx: MutationCtx,
  userId: Id<"users">,
  credits: number,
  note: string,
  now = Date.now(),
  stripeCustomerId?: string,
) {
  const sub = await ensureCurrent(ctx, userId, now);
  const balance = sub.credits + credits;
  await ctx.db.patch(sub._id, {
    credits: balance,
    granted: sub.granted + credits,
    stripeCustomerId: stripeCustomerId ?? sub.stripeCustomerId,
    updatedAt: now,
  });
  await record(ctx, userId, "topup", credits, balance, note, now);
}

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
    if (pack) {
      const current = await subscriptionFor(ctx, userId);
      const key = current ? projected(current, Date.now()).planKey : "free";
      if (!planFor(key).topUps) throw new ConvexError(`Extra credits come with the ${cheapestWith("topUps")} plan`);
    }
    const credits = Math.round(pack?.credits ?? args.credits ?? 0);
    if (credits <= 0) throw new ConvexError("A top-up needs a pack or a credit amount");
    await creditTopUp(ctx, userId, credits, args.note ?? `${credits} credit top-up`);
  },
});
