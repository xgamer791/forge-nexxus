import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedConversation } from "./access";
import { touchSite } from "./sites";
import { mutation, query } from "./_generated/server";

// This failure is a deployment setting, not something the member can fix from
// the thread. It stays in the build log and off the dashboard.
export function hiddenFromDashboard(body: string) {
  return body.includes("returned only its reasoning and no page");
}

export const list = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(v.object({
    _id: v.id("messages"),
    _creationTime: v.number(),
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    body: v.string(),
    status: v.optional(v.union(v.literal("pending"), v.literal("failed"))),
    versionId: v.optional(v.id("siteVersions")),
  })),
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(conversationId);
    if (!userId || !conversation || conversation.userId !== userId) return [];
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("asc")
      .collect();
    return rows.filter((message) => message.status !== "failed" && !hiddenFromDashboard(message.body));
  },
});

export const send = mutation({
  args: { conversationId: v.id("conversations"), body: v.string() },
  handler: async (ctx, { conversationId, body }) => {
    const text = body.trim();
    if (!text) throw new ConvexError("Message is empty");
    await requireOwnedConversation(ctx, conversationId);
    const now = Date.now();
    const id = await ctx.db.insert("messages", { conversationId, role: "user", body: text });
    await ctx.db.patch(conversationId, { updatedAt: now });
    await touchSite(ctx, conversationId, now);
    return id;
  },
});
