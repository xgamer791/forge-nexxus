import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedConversation } from "./access";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(conversationId);
    if (!userId || !conversation || conversation.userId !== userId) return [];
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("asc")
      .collect();
  },
});

export const send = mutation({
  args: { conversationId: v.id("conversations"), body: v.string() },
  handler: async (ctx, { conversationId, body }) => {
    const text = body.trim();
    if (!text) throw new ConvexError("Message is empty");
    await requireOwnedConversation(ctx, conversationId);
    const id = await ctx.db.insert("messages", { conversationId, role: "user", body: text });
    await ctx.db.patch(conversationId, { updatedAt: Date.now() });
    return id;
  },
});
