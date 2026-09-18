import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireOwnedWorkspace, requireUserId } from "./access";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { workspaceEnvironment, workspaceProtocol } from "./schema";

// The stored credential never leaves the server. Everything a client is allowed
// to see about a workspace goes through here.
function published(workspace: Doc<"workspaces">) {
  const { secret: _secret, userId: _userId, ...rest } = workspace;
  return rest;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return workspaces.sort((a, b) => a.createdAt - b.createdAt).map(published);
  },
});

export const rename = mutation({
  args: { id: v.id("workspaces"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await requireOwnedWorkspace(ctx, id);
    const label = name.trim();
    if (!label) throw new ConvexError("A workspace needs a name");
    await ctx.db.patch(id, { name: label });
  },
});

export const setEnvironment = mutation({
  args: { id: v.id("workspaces"), environment: v.optional(workspaceEnvironment) },
  handler: async (ctx, { id, environment }) => {
    await requireOwnedWorkspace(ctx, id);
    await ctx.db.patch(id, { environment });
  },
});

export const remove = mutation({
  args: { id: v.id("workspaces") },
  handler: async (ctx, { id }) => {
    await requireOwnedWorkspace(ctx, id);
    await ctx.db.delete(id);
  },
});

// Sessions are per call rather than long-lived, so disconnecting is a local
// state change: it stops the workspace being the one commands run against.
export const disconnect = mutation({
  args: { id: v.id("workspaces") },
  handler: async (ctx, { id }) => {
    await requireOwnedWorkspace(ctx, id);
    await ctx.db.patch(id, { connected: false });
  },
});

export const claim = internalQuery({
  args: {},
  handler: async (ctx) => await requireUserId(ctx),
});

export const credentialFor = internalQuery({
  args: { id: v.id("workspaces"), userId: v.id("users") },
  handler: async (ctx, { id, userId }) => {
    const workspace = await ctx.db.get(id);
    if (!workspace || workspace.userId !== userId) throw new ConvexError("Workspace not found");
    return workspace;
  },
});

export const save = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    protocol: workspaceProtocol,
    host: v.string(),
    port: v.number(),
    username: v.string(),
    environment: v.optional(workspaceEnvironment),
    authKind: v.union(v.literal("key"), v.literal("password")),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("workspaces", {
      ...args,
      connected: false,
      createdAt: Date.now(),
    });
  },
});

// Connecting marks one workspace live at a time: that is the server the app
// treats as the current shell.
export const markConnected = internalMutation({
  args: {
    id: v.id("workspaces"),
    userId: v.id("users"),
    connected: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, userId, connected, error }) => {
    const workspace = await ctx.db.get(id);
    if (!workspace || workspace.userId !== userId) throw new ConvexError("Workspace not found");
    if (connected) {
      const siblings = await ctx.db
        .query("workspaces")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      await Promise.all(
        siblings
          .filter((item) => item._id !== id && item.connected)
          .map((item) => ctx.db.patch(item._id, { connected: false })),
      );
    }
    await ctx.db.patch(id, {
      connected,
      lastError: error,
      ...(connected ? { lastConnectedAt: Date.now() } : {}),
    });
  },
});
