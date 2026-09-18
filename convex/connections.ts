import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedConnection, requireUserId } from "./access";
import { mutation, query } from "./_generated/server";
import { connectionKind } from "./shapes";

// The sheets render whatever this returns, so a signed-out or brand-new user
// simply sees empty lists. Names sort the pickers; Recents re-sorts by usedAt.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return connections.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const add = mutation({
  args: {
    kind: connectionKind,
    name: v.string(),
    detail: v.string(),
    connected: v.optional(v.boolean()),
  },
  handler: async (ctx, { kind, name, detail, connected }) => {
    const userId = await requireUserId(ctx);
    const label = name.trim();
    const target = detail.trim();
    if (!label || !target) throw new ConvexError("A workspace needs a name and an address");
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const duplicate = existing.find((item) => item.kind === kind && item.detail === target);
    if (duplicate) {
      await ctx.db.patch(duplicate._id, { name: label });
      return duplicate._id;
    }
    return await ctx.db.insert("connections", {
      userId,
      kind,
      name: label,
      detail: target,
      connected: connected === true,
      usedAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { id: v.id("connections"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const connection = await requireOwnedConnection(ctx, id);
    const label = name.trim();
    if (!label) throw new ConvexError("A workspace needs a name");
    await ctx.db.patch(connection._id, { name: label });
  },
});

export const remove = mutation({
  args: { id: v.id("connections") },
  handler: async (ctx, { id }) => {
    await requireOwnedConnection(ctx, id);
    await ctx.db.delete(id);
  },
});

// One workspace of a kind is active at a time, which is what "Connected" in the
// sheet means; connecting a second one hands the status over to it.
export const setConnected = mutation({
  args: { id: v.id("connections"), connected: v.boolean() },
  handler: async (ctx, { id, connected }) => {
    const connection = await requireOwnedConnection(ctx, id);
    if (connected) {
      const siblings = await ctx.db
        .query("connections")
        .withIndex("by_user", (q) => q.eq("userId", connection.userId))
        .collect();
      await Promise.all(
        siblings
          .filter((item) => item._id !== id && item.kind === connection.kind && item.connected)
          .map((item) => ctx.db.patch(item._id, { connected: false })),
      );
    }
    await ctx.db.patch(id, { connected, ...(connected ? { usedAt: Date.now() } : {}) });
  },
});
