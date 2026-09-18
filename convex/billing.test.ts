/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { addMonth, projected } from "./billing";
import { PLANS, REQUEST_COSTS, planFor } from "./plans";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

async function createUser(
  t: ReturnType<typeof fresh>,
  fields: { isAnonymous?: boolean; email?: string },
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

const free = planFor("free");
const starter = planFor("starter");
const premium = planFor("premium");
// What a brand-new member holds: the free period's allowance plus the welcome grant.
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits;
const DAY = 24 * 3600 * 1000;

describe("periods", () => {
  test("addMonth keeps the day and clamps at the end of a short month", () => {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(iso(addMonth(Date.UTC(2026, 0, 15)))).toBe("2026-02-15");
    expect(iso(addMonth(Date.UTC(2026, 0, 31)))).toBe("2026-02-28");
    expect(iso(addMonth(Date.UTC(2028, 0, 31)))).toBe("2028-02-29");
    expect(iso(addMonth(Date.UTC(2026, 11, 10)))).toBe("2027-01-10");
  });

  test("projected leaves a live period alone and rolls an ended one forward", () => {
    const start = Date.UTC(2026, 0, 10);
    const sub = {
      planKey: "starter" as const,
      periodStart: start,
      periodEnd: addMonth(start),
      credits: 12,
      reserved: 3,
      granted: 300,
      cancelAtPeriodEnd: false,
    };
    expect(projected(sub, start + 1000)).toBe(sub);
    const twoLater = addMonth(addMonth(start));
    const later = projected(sub, twoLater + 5);
    expect(later.periodStart).toBe(twoLater);
    expect(later.periodEnd).toBe(addMonth(twoLater));
    expect(later.credits).toBe(starter.monthlyCredits);
    expect(later.granted).toBe(starter.monthlyCredits);
    expect(later.reserved).toBe(3);
  });

  test("a scheduled downgrade lands when the period ends", () => {
    const start = Date.UTC(2026, 2, 1);
    const sub = {
      planKey: "starter" as const,
      periodStart: start,
      periodEnd: addMonth(start),
      credits: 0,
      reserved: 0,
      granted: 300,
      cancelAtPeriodEnd: true,
    };
    const next = projected(sub, addMonth(start));
    expect(next.planKey).toBe("free");
    expect(next.credits).toBe(free.monthlyCredits ?? 0);
    expect(next.cancelAtPeriodEnd).toBe(false);
  });
});

describe("billing", () => {
  test("summary is null for the signed-out and for guests, and the catalog is public", async () => {
    const t = fresh();
    expect(await t.query(api.billing.summary, {})).toBeNull();
    expect(await t.query(api.billing.history, {})).toEqual([]);
    const guest = await createUser(t, { isAnonymous: true });
    expect(await guest.as.query(api.billing.summary, {})).toBeNull();
    expect(await guest.as.query(api.billing.history, {})).toEqual([]);
    const catalog = await t.query(api.billing.catalog, {});
    expect(catalog.plans.map((plan) => plan.key)).toEqual(["free", "starter", "premium"]);
    expect(catalog.plans.map((plan) => plan.monthlyPriceCents)).toEqual([0, 3990, 6990]);
    expect(catalog.plans.map((plan) => plan.yearlyPriceCents)).toEqual([0, 28680, 50280]);
    expect(catalog.plans.map((plan) => plan.monthlyCredits)).toEqual([10, 600, 2000]);
    expect(catalog.plans[0].signupCredits).toBe(20);
    expect(catalog.topUps.length).toBeGreaterThan(0);
    expect(catalog.requestCosts).toEqual(REQUEST_COSTS);
  });

  test("a member starts on the free plan with its welcome credits", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    // Before any mutation the summary is projected from nothing: the period's
    // allowance only, since the welcome grant is written when the row is.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "free" },
      unlimited: false,
      credits: free.monthlyCredits ?? 0,
      reserved: 0,
      cancelAtPeriodEnd: false,
    });
    await t.mutation(internal.billing.ensure, { userId: member.userId });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: OPENING,
      available: OPENING,
      granted: OPENING,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "grant",
      amount: OPENING,
      balanceAfter: OPENING,
      note: "Welcome credits",
    });
    expect(history[0]).not.toHaveProperty("userId");
    // Ensuring twice does not grant twice.
    await t.mutation(internal.billing.ensure, { userId: member.userId });
    expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toHaveLength(1);
    expect(await member.as.query(api.billing.history, {})).toHaveLength(1);
  });

  test("ensure does nothing for a guest", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    await t.mutation(internal.billing.ensure, { userId: guest.userId });
    expect(await t.run((ctx) => ctx.db.query("subscriptions").collect())).toEqual([]);
  });

  test("a hold takes credits out of reach, settling spends them, releasing gives them back", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    const balance = OPENING + starter.monthlyCredits!;
    const { holdId, amount } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "generate",
    });
    expect(amount).toBe(REQUEST_COSTS.generate);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: balance,
      reserved: amount,
      available: balance - amount,
    });

    await t.mutation(internal.billing.settle, { holdId, amount: 3 });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: balance - 3,
      reserved: 0,
      available: balance - 3,
    });
    // Settling the same hold again changes nothing.
    await t.mutation(internal.billing.settle, { holdId });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(balance - 3);

    const second = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "image",
    });
    await t.mutation(internal.billing.release, { holdId: second.holdId });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: balance - 3,
      reserved: 0,
    });

    const history = await member.as.query(api.billing.history, {});
    expect(history.map((entry) => entry.kind)).toEqual(["spend", "grant", "grant"]);
    expect(history[0]).toMatchObject({ amount: -3, note: "Site build" });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => hold.status).sort()).toEqual(["released", "settled"]);
  });

  test("a request never settles for more than it held", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { holdId } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "edit",
    });
    await t.mutation(internal.billing.settle, { holdId, amount: 999 });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(OPENING - REQUEST_COSTS.edit);
  });

  test("the free welcome credits cannot cover a site build, and the refusal says so", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    expect(OPENING).toBeLessThan(REQUEST_COSTS.generate);
    await expect(
      t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "generate" }),
    ).rejects.toThrow(`Out of credits: this needs ${REQUEST_COSTS.generate} and you have ${OPENING}. Upgrade`);
    expect(await t.run((ctx) => ctx.db.query("creditHolds").collect())).toEqual([]);
  });

  test("no plan hands out unlimited credits", () => {
    // An unlimited plan is unlimited provider spend against a fixed price. The
    // machinery for one is still here, but nothing sold may use it.
    for (const plan of PLANS) expect(plan.monthlyCredits).not.toBeNull();
  });

  test("the top plan spends its allowance down, and every spend is written down", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    const opening = OPENING + premium.monthlyCredits!;
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "premium" },
      unlimited: false,
      credits: opening,
      available: opening,
    });
    for (let i = 0; i < 5; i += 1) {
      const { holdId } = await t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "video" });
      await t.mutation(internal.billing.settle, { holdId });
    }
    const summary = (await member.as.query(api.billing.summary, {}))!;
    expect(summary.reserved).toBe(0);
    expect(summary.credits).toBe(opening - 5 * REQUEST_COSTS.video);
    const spends = (await member.as.query(api.billing.history, {})).filter((entry) => entry.kind === "spend");
    expect(spends).toHaveLength(5);
    expect(spends[0]).toMatchObject({ amount: -REQUEST_COSTS.video, note: "Video" });
  });

  test("the top plan runs out like any other, so a period cannot cost without end", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", member.userId))
        .unique();
      await ctx.db.patch(sub!._id, { credits: REQUEST_COSTS.generate - 1 });
    });
    await expect(
      t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "generate" }),
    ).rejects.toThrow("Out of credits");
  });

  test("holds stop at the balance, so a burst of requests cannot overspend", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    const balance = OPENING + starter.monthlyCredits!;
    let held = 0;
    for (;;) {
      try {
        await t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "generate" });
        held += 1;
      } catch (error) {
        expect(String(error)).toContain("Out of credits");
        break;
      }
    }
    expect(held * REQUEST_COSTS.generate).toBeLessThanOrEqual(balance);
    expect((held + 1) * REQUEST_COSTS.generate).toBeGreaterThan(balance);
    const summary = (await member.as.query(api.billing.summary, {}))!;
    expect(summary.credits).toBe(balance);
    expect(summary.available).toBeLessThan(REQUEST_COSTS.generate);
  });

  test("guests cannot hold credits", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    await expect(
      t.mutation(internal.billing.reserve, { userId: guest.userId, requestKind: "edit" }),
    ).rejects.toThrow("Sign in to build");
  });

  test("a period that ended expires what was left and grants the new allowance", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    // Age the stored period by hand, the way time would.
    const past = Date.now() - 40 * DAY;
    await t.run(async (ctx) => {
      const sub = (await ctx.db.query("subscriptions").first())!;
      await ctx.db.patch(sub._id, { periodStart: past, periodEnd: addMonth(past), credits: 7 });
      for (const entry of await ctx.db.query("creditLedger").collect()) {
        await ctx.db.patch(entry._id, { createdAt: past });
      }
    });
    // A query reports the period as it will be once a mutation rolls it.
    const view = (await member.as.query(api.billing.summary, {}))!;
    expect(view.credits).toBe(starter.monthlyCredits);
    expect(view.periodEnd).toBeGreaterThan(Date.now());
    expect(view.periodStart).toBeLessThanOrEqual(Date.now());
    const { holdId } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "edit",
    });
    await t.mutation(internal.billing.release, { holdId });
    const history = await member.as.query(api.billing.history, {});
    expect(history.slice(0, 2).map((entry) => [entry.kind, entry.amount])).toEqual([
      ["grant", starter.monthlyCredits],
      ["expire", -7],
    ]);
    const stored = (await t.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(stored.periodStart).toBe(view.periodStart);
    expect(stored.credits).toBe(starter.monthlyCredits);
  });

  test("a free period that ends can still talk, and still cannot build", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.ensure, { userId: member.userId });
    // The welcome grant plus the first period's allowance, and less than a build.
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(OPENING);
    expect(OPENING).toBeLessThan(REQUEST_COSTS.generate);
    // Age the stored period by hand, the way time would.
    const past = Date.now() - 40 * DAY;
    await t.run(async (ctx) => {
      const sub = (await ctx.db.query("subscriptions").first())!;
      await ctx.db.patch(sub._id, { periodStart: past, periodEnd: addMonth(past) });
    });
    // The welcome grant is one-off, so what is left expires -- but the monthly
    // allowance arrives, which is what keeps a free member able to talk.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits,
      available: free.monthlyCredits,
      granted: free.monthlyCredits,
    });
    const { holdId } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "chat",
    });
    await t.mutation(internal.billing.settle, { holdId });
    // Talking, yes. Building, still not without upgrading.
    expect(free.monthlyCredits!).toBeLessThan(REQUEST_COSTS.generate);
    await expect(
      t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "generate" }),
    ).rejects.toThrow("Out of credits");
  });

  test("cancel schedules the free plan for the period end; resume undoes it", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await expect(member.as.action(api.billing.cancel, {})).rejects.toThrow("already on the free plan");
    await t.mutation(internal.billing.grantPlan, { email: "m@example.com", plan: "starter" });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "starter" },
      credits: OPENING + starter.monthlyCredits!,
      granted: OPENING + starter.monthlyCredits!,
      cancelAtPeriodEnd: false,
    });
    await member.as.action(api.billing.cancel, {});
    const canceled = (await member.as.query(api.billing.summary, {}))!;
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(canceled.plan.key).toBe("starter");
    await member.as.action(api.billing.resume, {});
    expect((await member.as.query(api.billing.summary, {}))!.cancelAtPeriodEnd).toBe(false);
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.action(api.billing.cancel, {})).rejects.toThrow("Sign in to change your plan");
  });

  test("top-ups add to the current period and are recorded", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await expect(
      t.mutation(internal.billing.grantTopUp, { userId: member.userId, pack: "topup-100" }),
    ).rejects.toThrow("Extra credits come with the Premium plan");
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    await t.mutation(internal.billing.grantTopUp, { userId: member.userId, pack: "topup-100" });
    await t.mutation(internal.billing.grantTopUp, {
      email: "M@example.com",
      credits: 7,
      note: "Sorry about the outage",
    });
    const opening = OPENING + premium.monthlyCredits!;
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: opening + 107,
      granted: opening + 107,
    });
    const history = await member.as.query(api.billing.history, {});
    // Two grants: the welcome credits, then the plan's own allowance.
    expect(history.map((entry) => entry.kind).sort()).toEqual(["grant", "grant", "topup", "topup"]);
    expect(history.find((entry) => entry.amount === 7)?.note).toBe("Sorry about the outage");
    expect(history.find((entry) => entry.amount === 100)?.note).toBe("100 credit top-up");
    await expect(
      t.mutation(internal.billing.grantTopUp, { userId: member.userId, pack: "topup-nope" }),
    ).rejects.toThrow("does not exist");
    await expect(
      t.mutation(internal.billing.grantTopUp, { email: "nobody@example.com", credits: 5 }),
    ).rejects.toThrow("No account");
    await expect(
      t.mutation(internal.billing.grantTopUp, { userId: member.userId, credits: 0 }),
    ).rejects.toThrow("needs a pack");
  });

  test("checkout is refused until payments are open", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await expect(member.as.action(api.billing.checkout, { plan: "premium" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    await expect(member.as.action(api.billing.checkout, { plan: "starter", interval: "year" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    // Packs are refused on plans without them before payments are even considered.
    await expect(member.as.action(api.billing.checkout, { topUp: "topup-100" })).rejects.toThrow(
      "Extra credits come with the Premium plan",
    );
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    await expect(member.as.action(api.billing.checkout, { topUp: "topup-100" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    await expect(member.as.action(api.billing.checkout, {})).rejects.toThrow("Choose a plan");
    await expect(member.as.action(api.billing.checkout, { plan: "free" })).rejects.toThrow(
      "Downgrading",
    );
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.action(api.billing.checkout, { plan: "premium" })).rejects.toThrow("Sign in");
  });

  test("balances and history are private to the account", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantTopUp, { userId: alice.userId, credits: 10 });
    expect((await alice.as.query(api.billing.summary, {}))!.credits).toBe(OPENING + 10);
    await t.mutation(internal.billing.ensure, { userId: bob.userId });
    expect((await bob.as.query(api.billing.summary, {}))!.credits).toBe(OPENING);
    // Bob sees his own welcome grant and nothing of Alice's top-up.
    expect((await bob.as.query(api.billing.history, {})).map((entry) => entry.kind)).toEqual(["grant"]);
    expect((await alice.as.query(api.billing.history, {})).map((entry) => entry.kind)).toEqual(["topup", "grant"]);
  });
});
