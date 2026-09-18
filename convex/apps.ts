import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireUserId } from "./access";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { appShape } from "./shapes";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  },
});

// One workspace is active at a time, whether it is an app on a server or a
// repository, so activating either stands the other one down.
async function standDownOthers(
  ctx: MutationCtx,
  userId: Id<"users">,
  keep: Id<"apps"> | null,
) {
  const apps = await ctx.db
    .query("apps")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  await Promise.all(
    apps
      .filter((app) => app._id !== keep && app.active)
      .map((app) => ctx.db.patch(app._id, { active: false })),
  );
  const repos = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  await Promise.all(
    repos.filter((repo) => repo.connected).map((repo) => ctx.db.patch(repo._id, { connected: false })),
  );
}

export const activate = mutation({
  args: { id: v.id("apps") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const app = await ctx.db.get(id);
    if (!app || app.userId !== userId) throw new ConvexError("App not found");
    await standDownOthers(ctx, userId, id);
    await ctx.db.patch(id, { active: true, usedAt: Date.now() });
  },
});

export const clearActive = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await standDownOthers(ctx, userId, null);
  },
});

export const standDownApps = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    await Promise.all(
      apps.filter((app) => app.active).map((app) => ctx.db.patch(app._id, { active: false })),
    );
  },
});

// A scan is the server's current truth: apps it no longer reports are dropped,
// and an app that is still there keeps being the active one.
export const replaceForWorkspace = internalMutation({
  args: {
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    found: v.array(appShape),
  },
  handler: async (ctx, { userId, workspaceId, found }) => {
    const existing = await ctx.db
      .query("apps")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const keptPaths = new Set(found.map((app) => app.path));
    await Promise.all(
      existing.filter((app) => !keptPaths.has(app.path)).map((app) => ctx.db.delete(app._id)),
    );
    const byPath = new Map(existing.map((app) => [app.path, app]));
    const scannedAt = Date.now();
    await Promise.all(
      found.map((app) => {
        const already = byPath.get(app.path);
        if (already) {
          return ctx.db.patch(already._id, { name: app.name, scannedAt });
        }
        return ctx.db.insert("apps", {
          userId,
          workspaceId,
          name: app.name,
          path: app.path,
          active: false,
          scannedAt,
        });
      }),
    );
    return found.length;
  },
});
