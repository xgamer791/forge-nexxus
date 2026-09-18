/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { addMonth, projected } from "./billing";
import { REQUEST_COSTS, planFor } from "./plans";
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
      planKey: "pro" as const,
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
    expect(later.credits).toBe(planFor("pro").monthlyCredits);
    expect(later.granted).toBe(planFor("pro").monthlyCredits);
    expect(later.reserved).toBe(3);
  });

  test("a scheduled downgrade lands when the period ends", () => {
    const start = Date.UTC(2026, 2, 1);
    const sub = {
      planKey: "pro" as const,
      periodStart: start,
      periodEnd: addMonth(start),
      credits: 0,
      reserved: 0,
      granted: 300,
      cancelAtPeriodEnd: true,
    };
    const next = projected(sub, addMonth(start));
    expect(next.planKey).toBe("free");
    expect(next.credits).toBe(free.monthlyCredits);
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
    expect(catalog.plans.map((plan) => plan.key)).toEqual(["free", "starter", "pro", "business"]);
    expect(catalog.topUps.length).toBeGreaterThan(0);
    expect(catalog.requestCosts).toEqual(REQUEST_COSTS);
  });

  test("a member starts on the free plan with its monthly credits", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    // Before any mutation the summary is projected from nothing.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "free" },
      credits: free.monthlyCredits,
      available: free.monthlyCredits,
      reserved: 0,
      cancelAtPeriodEnd: false,
    });
    await t.mutation(internal.billing.ensure, { userId: member.userId });
    const history = await member.as.query(api.billing.history, {});
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "grant",
      amount: free.monthlyCredits,
      balanceAfter: free.monthlyCredits,
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
    const { holdId, amount } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "generate",
    });
    expect(amount).toBe(REQUEST_COSTS.generate);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits,
      reserved: amount,
      available: free.monthlyCredits - amount,
    });

    await t.mutation(internal.billing.settle, { holdId, amount: 3 });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits - 3,
      reserved: 0,
      available: free.monthlyCredits - 3,
    });
    // Settling the same hold again changes nothing.
    await t.mutation(internal.billing.settle, { holdId });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(free.monthlyCredits - 3);

    const second = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "image",
    });
    await t.mutation(internal.billing.release, { holdId: second.holdId });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits - 3,
      reserved: 0,
    });

    const history = await member.as.query(api.billing.history, {});
    expect(history.map((entry) => entry.kind)).toEqual(["spend", "grant"]);
    expect(history[0]).toMatchObject({ amount: -3, note: "Site generation" });
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
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      free.monthlyCredits - REQUEST_COSTS.edit,
    );
  });

  test("holds stop at the balance, so a burst of requests cannot overspend", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
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
    expect(held * REQUEST_COSTS.generate).toBeLessThanOrEqual(free.monthlyCredits);
    expect((held + 1) * REQUEST_COSTS.generate).toBeGreaterThan(free.monthlyCredits);
    const summary = (await member.as.query(api.billing.summary, {}))!;
    expect(summary.credits).toBe(free.monthlyCredits);
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
    await t.mutation(internal.billing.ensure, { userId: member.userId });
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
    expect(view.credits).toBe(free.monthlyCredits);
    expect(view.periodEnd).toBeGreaterThan(Date.now());
    expect(view.periodStart).toBeLessThanOrEqual(Date.now());
    const { holdId } = await t.mutation(internal.billing.reserve, {
      userId: member.userId,
      requestKind: "edit",
    });
    await t.mutation(internal.billing.release, { holdId });
    const history = await member.as.query(api.billing.history, {});
    expect(history.map((entry) => [entry.kind, entry.amount])).toEqual([
      ["grant", free.monthlyCredits],
      ["expire", -7],
      ["grant", free.monthlyCredits],
    ]);
    const stored = (await t.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(stored.periodStart).toBe(view.periodStart);
    expect(stored.credits).toBe(free.monthlyCredits);
  });

  test("cancel schedules the free plan for the period end; resume undoes it", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await expect(member.as.mutation(api.billing.cancel, {})).rejects.toThrow("already on the free plan");
    await t.mutation(internal.billing.grantPlan, { email: "m@example.com", plan: "pro" });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "pro" },
      credits: free.monthlyCredits + planFor("pro").monthlyCredits,
      granted: free.monthlyCredits + planFor("pro").monthlyCredits,
      cancelAtPeriodEnd: false,
    });
    await member.as.mutation(api.billing.cancel, {});
    const canceled = (await member.as.query(api.billing.summary, {}))!;
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(canceled.plan.key).toBe("pro");
    await member.as.mutation(api.billing.resume, {});
    expect((await member.as.query(api.billing.summary, {}))!.cancelAtPeriodEnd).toBe(false);
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.mutation(api.billing.cancel, {})).rejects.toThrow("Sign in to build");
  });

  test("top-ups add to the current period and are recorded", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantTopUp, { userId: member.userId, pack: "topup-50" });
    await t.mutation(internal.billing.grantTopUp, {
      email: "M@example.com",
      credits: 7,
      note: "Sorry about the outage",
    });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits + 57,
      granted: free.monthlyCredits + 57,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history.map((entry) => entry.kind).sort()).toEqual(["grant", "topup", "topup"]);
    expect(history.find((entry) => entry.amount === 7)?.note).toBe("Sorry about the outage");
    expect(history.find((entry) => entry.amount === 50)?.note).toBe("50 credit top-up");
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
    await expect(member.as.action(api.billing.checkout, { plan: "pro" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    await expect(member.as.action(api.billing.checkout, { topUp: "topup-50" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    await expect(member.as.action(api.billing.checkout, {})).rejects.toThrow("Choose a plan");
    await expect(member.as.action(api.billing.checkout, { plan: "free" })).rejects.toThrow(
      "Downgrading",
    );
    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.action(api.billing.checkout, { plan: "pro" })).rejects.toThrow("Sign in");
  });

  test("balances and history are private to the account", async () => {
    const t = fresh();
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    await t.mutation(internal.billing.grantTopUp, { userId: alice.userId, credits: 10 });
    expect((await alice.as.query(api.billing.summary, {}))!.credits).toBe(free.monthlyCredits + 10);
    expect((await bob.as.query(api.billing.summary, {}))!.credits).toBe(free.monthlyCredits);
    expect(await bob.as.query(api.billing.history, {})).toEqual([]);
  });
});
