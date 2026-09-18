import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { requireOwnedConversation, requireUserId } from "./access";
import { deleteAttachmentsFor } from "./attachments";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";

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
    await deleteConversation(ctx, id);
  },
});

// Removes a thread and everything hanging off it: its messages, and the site it
// belongs to along with that site's domains. Site deletion and account deletion
// both come through here, so the cascade lives in one place.
export async function deleteConversation(ctx: MutationCtx, conversationId: Id<"conversations">) {
  const site = await ctx.db
    .query("sites")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .first();
  if (site) {
    const domains = await ctx.db
      .query("domains")
      .withIndex("by_site", (q) => q.eq("siteId", site._id))
      .collect();
    await Promise.all(domains.map((domain) => ctx.db.delete(domain._id)));
    const versions = await ctx.db
      .query("siteVersions")
      .withIndex("by_site", (q) => q.eq("siteId", site._id))
      .collect();
    await Promise.all(versions.map((version) => ctx.db.delete(version._id)));
    await ctx.db.delete(site._id);
  }
  // The files a user attached go with the thread, blobs included.
  await deleteAttachmentsFor(ctx, conversationId);
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  await Promise.all(messages.map((message) => ctx.db.delete(message._id)));
  if (await ctx.db.get(conversationId)) await ctx.db.delete(conversationId);
}
