import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireMemberId, requireOwnedSite } from "./access";
import { currentPlan } from "./billing";
import { deleteConversation } from "./conversations";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";

const DEFAULT_NAME = "Untitled site";
const NAME_LIMIT = 80;

export function cleanSiteName(name: string | undefined) {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return (trimmed || DEFAULT_NAME).slice(0, NAME_LIMIT);
}

// Most recently edited first, which is how the drawer lists them.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const sites = await ctx.db
      .query("sites")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return sites.map(({ userId: _owner, ...site }) => site);
  },
});

// A site and its build thread are made together. Only members build, and a
// plan caps how many sites it holds.
export const create = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const userId = await requireMemberId(ctx);
    const plan = await currentPlan(ctx, userId);
    if (plan.maxSites !== null) {
      const owned = await ctx.db
        .query("sites")
        .withIndex("by_user_updated", (q) => q.eq("userId", userId))
        .collect();
      if (owned.length >= plan.maxSites) {
        throw new ConvexError(
          `The ${plan.name} plan holds ${plan.maxSites} sites. Upgrade to add more.`,
        );
      }
    }
    const now = Date.now();
    const title = cleanSiteName(name);
    const conversationId = await ctx.db.insert("conversations", { userId, title, updatedAt: now });
    const siteId = await ctx.db.insert("sites", {
      userId,
      conversationId,
      name: title,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    return { siteId, conversationId };
  },
});

export const rename = mutation({
  args: { id: v.id("sites"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const site = await requireOwnedSite(ctx, id);
    const title = cleanSiteName(name);
    await ctx.db.patch(id, { name: title });
    await ctx.db.patch(site.conversationId, { title });
  },
});

export const remove = mutation({
  args: { id: v.id("sites") },
  handler: async (ctx, { id }) => {
    const site = await requireOwnedSite(ctx, id);
    await deleteConversation(ctx, site.conversationId);
  },
});

// Sending a prompt is what makes a site recently edited.
export async function touchSite(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now: number,
) {
  const site = await ctx.db
    .query("sites")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .first();
  if (site) await ctx.db.patch(site._id, { updatedAt: now });
}
