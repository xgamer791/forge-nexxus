/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { addMonth } from "./billing";
import { planFor } from "./plans";
import schema from "./schema";
import { hmacHex, planForPrice, priceEnvName, verifySignature } from "./stripe";

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
const pro = planFor("pro");
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits;
const SECRET = "whsec_test_secret";
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: SECRET,
  SITE_URL: "https://example.test/forge-nexxus/",
  STRIPE_PRICE_STARTER_MONTH: "price_starter_m",
  STRIPE_PRICE_STARTER_YEAR: "price_starter_y",
  STRIPE_PRICE_PRO_MONTH: "price_pro_m",
  STRIPE_PRICE_PRO_YEAR: "price_pro_y",
  STRIPE_PRICE_ULTRA_MONTH: "price_ultra_m",
  STRIPE_PRICE_ULTRA_YEAR: "price_ultra_y",
  STRIPE_PRICE_PREMIUM_MONTH: "price_premium_m",
  STRIPE_PRICE_PREMIUM_YEAR: "price_premium_y",
  STRIPE_PRICE_TOPUP_1000: "price_topup_1000",
  // These tests are about what a purchase does, so packs are on sale here.
  // Their being off by default is covered in billing.test.ts.
  TOP_UPS_OPEN: "true",
};

beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of Object.keys(ENV)) delete process.env[name];
});

type Call = { url: string; method: string; body: URLSearchParams; auth: string | undefined };
function stubStripe(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const call = {
        url,
        method: init.method ?? "GET",
        body: new URLSearchParams(String(init.body ?? "")),
        auth: headers?.authorization,
      };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

async function signed(t: ReturnType<typeof fresh>, event: object, secret = SECRET, at = Date.now()) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(at / 1000);
  const signature = await hmacHex(secret, `${timestamp}.${payload}`);
  return t.fetch("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}`, "content-type": "application/json" },
    body: payload,
  });
}

describe("prices and signatures", () => {
  test("price ids come from the environment, one per plan and interval and one per pack", () => {
    expect(priceEnvName({ plan: "starter", interval: "year" })).toBe("STRIPE_PRICE_STARTER_YEAR");
    expect(priceEnvName({ plan: "pro", interval: "year" })).toBe("STRIPE_PRICE_PRO_YEAR");
    expect(priceEnvName({ pack: "topup-1000" })).toBe("STRIPE_PRICE_TOPUP_1000");
    expect(planForPrice("price_pro_y")).toEqual({ plan: "pro", interval: "year" });
    expect(planForPrice("price_premium_y")).toEqual({ plan: "pro", interval: "year" });
    expect(planForPrice("price_ultra_m")).toEqual({ plan: "ultra", interval: "month" });
    expect(planForPrice("price_nobody")).toBeNull();
  });

  test("a delivery is trusted only with a fresh, matching signature", async () => {
    const payload = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const good = await hmacHex(SECRET, `${timestamp}.${payload}`);
    expect(await verifySignature(payload, `t=${timestamp},v1=${good}`, SECRET)).toBe(true);
    expect(await verifySignature(payload, `t=${timestamp},v1=deadbeef,v1=${good}`, SECRET)).toBe(true);
    expect(await verifySignature(payload, `t=${timestamp},v1=${good}`, "whsec_other")).toBe(false);
    expect(await verifySignature(payload + " ", `t=${timestamp},v1=${good}`, SECRET)).toBe(false);
    expect(await verifySignature(payload, null, SECRET)).toBe(false);
    const stale = timestamp - 600;
    const staleSig = await hmacHex(SECRET, `${stale}.${payload}`);
    expect(await verifySignature(payload, `t=${stale},v1=${staleSig}`, SECRET)).toBe(false);
  });
});

describe("checkout", () => {
  test("a plan opens a subscription session with the member and plan in its metadata", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const calls = stubStripe(() => json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }));
    const { url } = await member.as.action(api.billing.checkout, { plan: "starter", interval: "year" });
    expect(url).toBe("https://checkout.stripe.com/c/cs_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0].auth).toBe("Bearer sk_test_123");
    const body = calls[0].body;
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price]")).toBe("price_starter_y");
    expect(body.get("metadata[userId]")).toBe(member.userId);
    expect(body.get("metadata[plan]")).toBe("starter");
    expect(body.get("subscription_data[metadata][plan]")).toBe("starter");
    expect(body.get("customer_email")).toBe("m@example.com");
    expect(body.get("success_url")).toBe("https://example.test/forge-nexxus/?checkout=success");
    expect(body.get("cancel_url")).toBe("https://example.test/forge-nexxus/?checkout=cancel");
  });

  test("a pack opens a payment session, only on a plan that allows packs, reusing the customer", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const calls = stubStripe(() => json({ id: "cs_2", url: "https://checkout.stripe.com/c/cs_2" }));
    await expect(member.as.action(api.billing.checkout, { topUp: "topup-1000" })).rejects.toThrow(
      "Extra credits come with the Pro plan",
    );
    await t.mutation(internal.billing.grantPlan, {
      userId: member.userId,
      plan: "pro",
      stripeCustomerId: "cus_42",
    });
    await member.as.action(api.billing.checkout, { topUp: "topup-1000" });
    const body = calls.at(-1)!.body;
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price]")).toBe("price_topup_1000");
    expect(body.get("metadata[pack]")).toBe("topup-1000");
    expect(body.get("customer")).toBe("cus_42");
    expect(body.get("customer_email")).toBeNull();
  });

  test("missing keys, missing prices, and Stripe errors are reported plainly", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    delete process.env.STRIPE_PRICE_STARTER_MONTH;
    stubStripe(() => json({ error: { message: "No such price" } }, 400));
    await expect(member.as.action(api.billing.checkout, { plan: "starter" })).rejects.toThrow(
      "isn't available yet",
    );
    await expect(member.as.action(api.billing.checkout, { plan: "pro" })).rejects.toThrow(
      "Stripe answered 400: No such price",
    );
    delete process.env.STRIPE_SECRET_KEY;
    await expect(member.as.action(api.billing.checkout, { plan: "pro" })).rejects.toThrow(
      "Payments aren't open yet",
    );
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    await expect(member.as.action(api.billing.checkout, { plan: "pro" })).rejects.toThrow(
      "already on that plan",
    );
  });
});

describe("webhook", () => {
  test("refuses deliveries it cannot trust", async () => {
    const t = fresh();
    const unsigned = await t.fetch("/stripe/webhook", { method: "POST", body: '{"id":"evt_x"}' });
    expect(unsigned.status).toBe(400);
    const wrongSecret = await signed(t, { id: "evt_x", type: "ping" }, "whsec_wrong");
    expect(wrongSecret.status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await signed(t, { id: "evt_x", type: "ping" })).status).toBe(503);
    expect(await t.run((ctx) => ctx.db.query("stripeEvents").collect())).toEqual([]);
  });

  test("a completed plan checkout puts the member on the plan once, however often it is delivered", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const event = {
      id: "evt_plan",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          client_reference_id: member.userId,
          metadata: { userId: member.userId, plan: "starter" },
        },
      },
    };
    const first = await signed(t, event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ handled: true, action: "plan", plan: "starter" });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "starter" },
      credits: OPENING + starter.monthlyCredits!,
      billingAccount: true,
    });
    const again = await signed(t, event);
    expect(await again.json()).toEqual({ handled: false, reason: "duplicate" });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(OPENING + starter.monthlyCredits!);
    const stored = (await t.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(stored).toMatchObject({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  });

  test("a paid pack is credited, and unknown users, plans, and packs are left alone", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "pro" });
    const pack = await signed(t, {
      id: "evt_pack",
      type: "checkout.session.completed",
      data: { object: { mode: "payment", customer: "cus_9", metadata: { userId: member.userId, pack: "topup-1000" } } },
    });
    expect(await pack.json()).toEqual({ handled: true, action: "topup", credits: 1000 });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      OPENING + pro.monthlyCredits! + 1000,
    );
    const bogus = await signed(t, {
      id: "evt_bogus",
      type: "checkout.session.completed",
      data: { object: { mode: "payment", metadata: { userId: member.userId, pack: "topup-nope" } } },
    });
    expect(await bogus.json()).toEqual({ handled: false, reason: "unknown pack" });
    const nobody = await signed(t, {
      id: "evt_nobody",
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { plan: "starter" } } },
    });
    expect(await nobody.json()).toEqual({ handled: false, reason: "no user" });
    const badPlan = await signed(t, {
      id: "evt_badplan",
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { userId: member.userId, plan: "free" } } },
    });
    expect(await badPlan.json()).toEqual({ handled: false, reason: "unknown plan" });
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      OPENING + pro.monthlyCredits! + 1000,
    );
    const legacy = await signed(t, {
      id: "evt_premium",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          customer: "cus_legacy",
          subscription: "sub_legacy",
          metadata: { userId: member.userId, plan: "premium" },
        },
      },
    });
    expect(await legacy.json()).toEqual({ handled: true, action: "plan", plan: "pro" });
    expect((await member.as.query(api.billing.summary, {}))!.plan.key).toBe("pro");
  });

  test("subscription updates sync cancellation and the period; a deletion ends the plan", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, {
      userId: member.userId,
      plan: "starter",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
    const periodStart = Math.floor(Date.now() / 1000);
    const periodEnd = Math.floor(addMonth(Date.now()) / 1000) + 3600;
    const updated = await signed(t, {
      id: "evt_upd",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          cancel_at_period_end: true,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          items: { data: [{ price: { id: "price_starter_m" } }] },
        },
      },
    });
    expect(await updated.json()).toEqual({ handled: true, action: "synced" });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      plan: { key: "starter" },
      cancelAtPeriodEnd: true,
      periodEnd: periodEnd * 1000,
    });
    // A price change through the portal moves the plan.
    const upgraded = await signed(t, {
      id: "evt_upgrade",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_premium_m" } }] },
        },
      },
    });
    expect(await upgraded.json()).toEqual({ handled: true, action: "plan", plan: "pro" });
    expect((await member.as.query(api.billing.summary, {}))!.plan.key).toBe("pro");
    const unknown = await signed(t, {
      id: "evt_unknown",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_other", customer: "cus_other" } },
    });
    expect(await unknown.json()).toEqual({ handled: false, reason: "unknown subscription" });
    const deleted = await signed(t, {
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1" } },
    });
    expect(await deleted.json()).toEqual({ handled: true, action: "ended" });
    expect((await member.as.query(api.billing.summary, {}))!.plan.key).toBe("free");
    const stored = (await t.run((ctx) => ctx.db.query("subscriptions").first()))!;
    expect(stored.stripeSubscriptionId).toBeUndefined();
    expect(stored.stripeCustomerId).toBe("cus_1");
  });

  test("a renewal invoice opens a fresh period: the leftover expires and the allowance is granted", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, {
      userId: member.userId,
      plan: "starter",
      stripeSubscriptionId: "sub_1",
    });
    await t.run(async (ctx) => {
      const sub = (await ctx.db.query("subscriptions").first())!;
      await ctx.db.patch(sub._id, { credits: 7, granted: 7 });
    });
    const start = Math.floor(Date.now() / 1000);
    const end = Math.floor(addMonth(Date.now()) / 1000);
    const renewed = await signed(t, {
      id: "evt_renew",
      type: "invoice.paid",
      data: {
        object: {
          subscription: "sub_1",
          billing_reason: "subscription_cycle",
          lines: { data: [{ period: { start, end } }] },
        },
      },
    });
    expect(await renewed.json()).toEqual({ handled: true, action: "renewed" });
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: starter.monthlyCredits,
      granted: starter.monthlyCredits,
      periodStart: start * 1000,
      periodEnd: end * 1000,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history.slice(0, 2).map((entry) => [entry.kind, entry.amount])).toEqual([
      ["grant", starter.monthlyCredits],
      ["expire", -7],
    ]);
    const first = await signed(t, {
      id: "evt_first",
      type: "invoice.paid",
      data: { object: { subscription: "sub_1", billing_reason: "subscription_create" } },
    });
    expect(await first.json()).toEqual({ handled: false, reason: "ignored" });
  });
});

describe("how a payment divides", () => {
  test("half of what Stripe collected is the provider budget and half is Forge's", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await signed(t, {
      id: "evt_plan",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          customer: "cus_1",
          subscription: "sub_1",
          amount_total: starter.monthlyPriceCents,
          currency: "usd",
          metadata: { userId: member.userId, plan: "starter" },
        },
      },
    });
    await signed(t, {
      id: "evt_renew",
      type: "invoice.paid",
      data: {
        object: {
          subscription: "sub_1",
          billing_reason: "subscription_cycle",
          amount_paid: starter.monthlyPriceCents,
          currency: "usd",
        },
      },
    });
    const rows = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(rows.map((row) => [row.source, row.paidCents, row.apiCents, row.forgeCents])).toEqual([
      ["plan", 6000, 3000, 3000],
      ["renewal", 6000, 3000, 3000],
    ]);
    expect(rows[0]).toMatchObject({ planKey: "starter", currency: "usd", stripeEventId: "evt_plan" });
    expect(await t.query(internal.billing.funding, {})).toEqual({
      payments: 2,
      paidCents: 12000,
      apiCents: 6000,
      forgeCents: 6000,
      spentCents: 0,
      metered: 0,
      unmetered: 0,
      budgetLeftCents: 6000,
    });
  });

  test("a month that collected nothing records nothing, and an odd amount still adds up", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    // A full-discount coupon still puts the member on the plan.
    const discounted = await signed(t, {
      id: "evt_free",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          subscription: "sub_1",
          amount_total: 0,
          currency: "usd",
          metadata: { userId: member.userId, plan: "starter" },
        },
      },
    });
    expect(await discounted.json()).toEqual({ handled: true, action: "plan", plan: "starter" });
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toEqual([]);
    await signed(t, {
      id: "evt_pack",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "payment",
          amount_total: 2999,
          currency: "usd",
          metadata: { userId: member.userId, pack: "topup-1000" },
        },
      },
    });
    const [pack] = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(pack).toMatchObject({ source: "topup", pack: "topup-1000", paidCents: 2999, apiCents: 1500, forgeCents: 1499 });
  });
});

describe("cancel, resume, and the portal", () => {
  test("cancelling and resuming tell Stripe when it bills the plan, and only then", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const calls = stubStripe(() => json({ id: "sub_1", cancel_at_period_end: true }));
    await expect(member.as.action(api.billing.cancel, {})).rejects.toThrow("already on the free plan");
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
    await member.as.action(api.billing.cancel, {});
    expect(calls).toHaveLength(0);
    expect((await member.as.query(api.billing.summary, {}))!.cancelAtPeriodEnd).toBe(true);
    await member.as.action(api.billing.resume, {});
    expect((await member.as.query(api.billing.summary, {}))!.cancelAtPeriodEnd).toBe(false);

    await t.run(async (ctx) => {
      const sub = (await ctx.db.query("subscriptions").first())!;
      await ctx.db.patch(sub._id, { stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    });
    await member.as.action(api.billing.cancel, {});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(calls[0].body.get("cancel_at_period_end")).toBe("true");
    await member.as.action(api.billing.resume, {});
    expect(calls[1].body.get("cancel_at_period_end")).toBe("false");
    expect((await member.as.query(api.billing.summary, {}))!.cancelAtPeriodEnd).toBe(false);
  });

  test("the portal needs a billing account", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const calls = stubStripe(() => json({ url: "https://billing.stripe.com/p/session_1" }));
    await expect(member.as.action(api.billing.portal, {})).rejects.toThrow("no billing account");
    await t.mutation(internal.billing.grantPlan, {
      userId: member.userId,
      plan: "starter",
      stripeCustomerId: "cus_1",
    });
    expect(await member.as.action(api.billing.portal, {})).toEqual({ url: "https://billing.stripe.com/p/session_1" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(calls[0].body.get("customer")).toBe("cus_1");
    expect(calls[0].body.get("return_url")).toBe("https://example.test/forge-nexxus/?screen=plan");
  });
});
