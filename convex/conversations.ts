import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { requireOwnedConversation, requireUserId } from "./access";
import { mutation, query } from "./_generated/server";

const DEFAULT_TITLE = "New conversation";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, { title }) => {
    const userId = await requireUserId(ctx);
    return await ctx.db.insert("conversations", {
      userId,
      title: title?.trim() || DEFAULT_TITLE,
      updatedAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { id: v.id("conversations"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    await requireOwnedConversation(ctx, id);
    await ctx.db.patch(id, { title: title.trim() || DEFAULT_TITLE });
  },
});

export const remove = mutation({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }) => {
    await requireOwnedConversation(ctx, id);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .collect();
    await Promise.all(messages.map((message) => ctx.db.delete(message._id)));
    await ctx.db.delete(id);
  },
});
