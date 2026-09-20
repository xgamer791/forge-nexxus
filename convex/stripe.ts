import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation } from "./_generated/server";
import { addMonth, applyPlan, creditTopUp, subscriptionByStripe } from "./billing";
import { PAID_PLAN_KEYS, normalizePlanKey, paidPlanKey, topUpFor, type PlanKey } from "./plans";

// Stripe over its REST API with form encoding, which is all checkout, the
// portal and subscription updates need: no SDK, nothing to bundle. Price ids
// live in the deployment's environment, one per plan and interval and one per
// credit pack, so test and live modes are a matter of which keys are set.
const API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export type Interval = "month" | "year";

export function priceEnvName(choice: { plan: PlanKey; interval: Interval } | { pack: string }) {
  return "pack" in choice
    ? `STRIPE_PRICE_${choice.pack.toUpperCase().replace(/-/g, "_")}`
    : `STRIPE_PRICE_${choice.plan.toUpperCase()}_${choice.interval.toUpperCase()}`;
}

export function priceIdFor(choice: { plan: PlanKey; interval: Interval } | { pack: string }) {
  const named = process.env[priceEnvName(choice)] || null;
  if (named) return named;
  // Premium price ids still sell Pro until the deployment is given PRO keys.
  if ("plan" in choice && choice.plan === "pro") {
    return process.env[`STRIPE_PRICE_PREMIUM_${choice.interval.toUpperCase()}`] || null;
  }
  return null;
}

// The plan a Stripe price id stands for, by matching it against the ids the
// deployment was given. Null for a price that is not one of ours.
export function planForPrice(priceId: string): { plan: PlanKey; interval: Interval } | null {
  for (const plan of PAID_PLAN_KEYS) {
    for (const interval of ["month", "year"] as const) {
      if (priceIdFor({ plan, interval }) === priceId) return { plan, interval };
    }
  }
  for (const interval of ["month", "year"] as const) {
    const legacy = process.env[`STRIPE_PRICE_PREMIUM_${interval.toUpperCase()}`];
    if (legacy && legacy === priceId) return { plan: "pro", interval };
  }
  return null;
}

export async function stripeRequest(
  path: string,
  params: Record<string, string> = {},
  method: "POST" | "GET" = "POST",
) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ConvexError("Payments aren't open yet. Plans and top-ups will be available soon.");
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* Stripe always answers JSON; a non-JSON body is reported by status below. */
  }
  if (!response.ok) {
    const detail = typeof data?.error?.message === "string" ? `: ${data.error.message}` : "";
    throw new ConvexError(`Stripe answered ${response.status}${detail}`);
  }
  return data;
}

function siteUrl() {
  const url = process.env.SITE_URL?.replace(/\/+$/, "");
  if (!url) throw new ConvexError("SITE_URL is not set on this deployment");
  return url;
}

// A Checkout Session for a plan (a subscription) or a credit pack (a one-off
// payment). The user id rides in the metadata so the webhook knows whose it
// is; a returning customer is reused so Stripe keeps one record per member.
export async function createCheckoutSession(input: {
  userId: Id<"users">;
  email: string | null;
  stripeCustomerId: string | null;
  plan?: PlanKey;
  interval?: Interval;
  pack?: string;
}) {
  // No key means payments are not open at all, which is the plainer thing to
  // say; a missing price is one option not yet on sale.
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ConvexError("Payments aren't open yet. Plans and top-ups will be available soon.");
  }
  const choice = input.plan
    ? { plan: input.plan, interval: input.interval ?? ("month" as Interval) }
    : { pack: input.pack ?? "" };
  const price = priceIdFor(choice);
  if (!price) throw new ConvexError("That option isn't available yet");
  const site = siteUrl();
  const params: Record<string, string> = {
    mode: input.plan ? "subscription" : "payment",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: `${site}/?checkout=success`,
    cancel_url: `${site}/?checkout=cancel`,
    client_reference_id: input.userId,
    "metadata[userId]": input.userId,
    allow_promotion_codes: "true",
  };
  if (input.plan) {
    params["metadata[plan]"] = input.plan;
    params["subscription_data[metadata][userId]"] = input.userId;
    params["subscription_data[metadata][plan]"] = input.plan;
  } else {
    params["metadata[pack]"] = input.pack ?? "";
    params.customer_creation = "always";
  }
  if (input.stripeCustomerId) params.customer = input.stripeCustomerId;
  else if (input.email) params.customer_email = input.email;
  const session = await stripeRequest("/checkout/sessions", params);
  if (typeof session?.url !== "string") throw new ConvexError("Stripe did not return a checkout page");
  return { url: session.url as string };
}

export async function createPortalSession(stripeCustomerId: string) {
  const session = await stripeRequest("/billing_portal/sessions", {
    customer: stripeCustomerId,
    return_url: `${siteUrl()}/?screen=plan`,
  });
  if (typeof session?.url !== "string") throw new ConvexError("Stripe did not return a billing page");
  return { url: session.url as string };
}

// Stripe signs each delivery with HMAC-SHA256 over "<timestamp>.<body>"; a
// delivery is trusted only if a signature matches and the timestamp is fresh.
export async function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  now = Date.now(),
) {
  if (!header) return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith("t="))?.slice(2));
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// POST /stripe/webhook. Verifies, then hands the event to one transaction
// that also records its id, so a redelivery can never grant twice.
export const webhook = httpAction(async (ctx, request) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook not configured", { status: 503 });
  const payload = await request.text();
  if (!(await verifySignature(payload, request.headers.get("stripe-signature"), secret))) {
    return new Response("Bad signature", { status: 400 });
  }
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  const outcome = await ctx.runMutation(internal.stripe.applyEvent, { event });
  return new Response(JSON.stringify(outcome), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const seconds = (value: unknown) => (typeof value === "number" && value > 0 ? value * 1000 : null);

export const applyEvent = internalMutation({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    const id = typeof event?.id === "string" ? event.id : null;
    const type = typeof event?.type === "string" ? event.type : "";
    if (!id) throw new ConvexError("Malformed event");
    const seen = await ctx.db
      .query("stripeEvents")
      .withIndex("by_event", (q) => q.eq("eventId", id))
      .first();
    if (seen) return { handled: false, reason: "duplicate" };
    await ctx.db.insert("stripeEvents", { eventId: id, type, receivedAt: Date.now() });
    const object = event?.data?.object ?? {};
    const now = Date.now();

    if (type === "checkout.session.completed") {
      const userId = (object.metadata?.userId ?? object.client_reference_id) as Id<"users"> | undefined;
      if (!userId || !(await ctx.db.get(userId))) return { handled: false, reason: "no user" };
      const customer = typeof object.customer === "string" ? object.customer : undefined;
      if (object.mode === "subscription" && typeof object.metadata?.plan === "string") {
        const plan = paidPlanKey(object.metadata.plan);
        if (!plan) return { handled: false, reason: "unknown plan" };
        await applyPlan(ctx, userId, plan, {
          now,
          stripeCustomerId: customer,
          stripeSubscriptionId: typeof object.subscription === "string" ? object.subscription : undefined,
        });
        return { handled: true, action: "plan", plan };
      }
      if (object.mode === "payment" && typeof object.metadata?.pack === "string") {
        const pack = topUpFor(object.metadata.pack);
        if (!pack) return { handled: false, reason: "unknown pack" };
        // A paid pack is honoured whatever the plan says: the money has moved.
        await creditTopUp(ctx, userId, pack.credits, `${pack.credits} credit top-up`, now, customer);
        return { handled: true, action: "topup", credits: pack.credits };
      }
      return { handled: false, reason: "unrecognised session" };
    }

    if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const sub = await subscriptionByStripe(ctx, {
        subscriptionId: typeof object.id === "string" ? object.id : undefined,
        customerId: typeof object.customer === "string" ? object.customer : undefined,
      });
      if (!sub) return { handled: false, reason: "unknown subscription" };
      if (type === "customer.subscription.deleted") {
        await applyPlan(ctx, sub.userId, "free", { now, stripeSubscriptionId: null });
        return { handled: true, action: "ended" };
      }
      const priceId = object.items?.data?.[0]?.price?.id;
      const mapped = typeof priceId === "string" ? planForPrice(priceId) : null;
      const periodStart = seconds(object.current_period_start);
      const periodEnd = seconds(object.current_period_end);
      const current = normalizePlanKey(sub.planKey);
      if (mapped && mapped.plan !== current && object.status === "active") {
        await applyPlan(ctx, sub.userId, mapped.plan, { now, periodStart, periodEnd });
        return { handled: true, action: "plan", plan: mapped.plan };
      }
      await ctx.db.patch(sub._id, {
        planKey: current,
        cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
        ...(periodStart && periodEnd ? { periodStart, periodEnd } : {}),
        updatedAt: now,
      });
      return { handled: true, action: "synced" };
    }

    if (type === "invoice.paid" && object.billing_reason === "subscription_cycle") {
      const sub = await subscriptionByStripe(ctx, {
        subscriptionId: typeof object.subscription === "string" ? object.subscription : undefined,
        customerId: typeof object.customer === "string" ? object.customer : undefined,
      });
      if (!sub) return { handled: false, reason: "unknown subscription" };
      const line = object.lines?.data?.[0]?.period;
      const periodStart = seconds(line?.start) ?? now;
      const periodEnd = seconds(line?.end) ?? addMonth(periodStart);
      // A renewal opens a fresh period on the same plan: the leftover expires
      // and the allowance is granted again.
      await applyPlan(ctx, sub.userId, normalizePlanKey(sub.planKey), { now, periodStart, periodEnd, renewal: true });
      return { handled: true, action: "renewed" };
    }

    return { handled: false, reason: "ignored" };
  },
});
