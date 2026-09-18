import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedDomain, requireOwnedSite } from "./access";
import { currentPlan } from "./billing";
import { HOSTNAME, isReservedHost, normalizeHostname } from "./hosting";
import { PLANS } from "./plans";
import { internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const domains = await ctx.db
      .query("domains")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return domains.map(({ userId: _owner, ...domain }) => domain);
  },
});

export const add = mutation({
  args: { siteId: v.id("sites"), hostname: v.string() },
  handler: async (ctx, { siteId, hostname }) => {
    const site = await requireOwnedSite(ctx, siteId);
    const plan = await currentPlan(ctx, site.userId);
    if (!plan.customDomains) {
      const needed = PLANS.find((candidate) => candidate.customDomains)?.name ?? "Premium";
      throw new ConvexError(`Custom domains come with the ${needed} plan`);
    }
    const host = normalizeHostname(hostname);
    if (!HOSTNAME.test(host)) throw new ConvexError("Enter a domain like example.com");
    // Forge's own addresses are not a member's to claim: every site already has
    // one, and handing out a second claim on it would take another site's
    // traffic.
    if (isReservedHost(host)) {
      throw new ConvexError("That address is Forge's own. Add a domain you own.");
    }
    // A hostname answers for one site across the whole deployment, so the claim
    // is refused whoever already holds it -- saying which, since a member cannot
    // see a row that is not theirs and would otherwise have nothing to act on.
    const claimed = await ctx.db
      .query("domains")
      .withIndex("by_hostname", (q) => q.eq("hostname", host))
      .first();
    if (claimed) {
      throw new ConvexError(
        claimed.userId === site.userId
          ? "That domain is already added"
          : "That domain is already pointed at another Forge site",
      );
    }
    return await ctx.db.insert("domains", {
      userId: site.userId,
      siteId,
      hostname: host,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("domains") },
  handler: async (ctx, { id }) => {
    await requireOwnedDomain(ctx, id);
    await ctx.db.delete(id);
  },
});

// Forge served a request for this hostname. The public route calls it the first
// time, which is what moves a domain from `pending` to `active` in the member's
// list: no request can arrive until their DNS points here, so being asked for
// the name is how the app learns the record is in place.
export const markVerified = internalMutation({
  args: { id: v.id("domains") },
  handler: async (ctx, { id }) => {
    const domain = await ctx.db.get(id);
    if (!domain || domain.status === "active") return;
    await ctx.db.patch(id, { status: "active", verifiedAt: Date.now() });
  },
});
