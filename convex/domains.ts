import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedDomain, requireOwnedSite } from "./access";
import { currentPlan } from "./billing";
import { mutation, query } from "./_generated/server";

// Labels of letters, digits and inner hyphens, then a real top-level domain.
const HOSTNAME = /^(?=.{1,253}$)((?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

// What a user pastes is often a URL; keep just the host they meant.
export function normalizeHostname(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

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
    if (!plan.customDomains) throw new ConvexError("Custom domains need a paid plan");
    const host = normalizeHostname(hostname);
    if (!HOSTNAME.test(host)) throw new ConvexError("Enter a domain like example.com");
    const owned = await ctx.db
      .query("domains")
      .withIndex("by_user", (q) => q.eq("userId", site.userId))
      .collect();
    if (owned.some((domain) => domain.hostname === host)) {
      throw new ConvexError("That domain is already added");
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
