import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { requireUserId } from "./access";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const fields = {
  theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
  density: v.optional(v.number()),
  codeWrap: v.optional(v.boolean()),
  themedDiff: v.optional(v.boolean()),
  reduceTransparency: v.optional(v.boolean()),
  uiFont: v.optional(v.string()),
  codeFont: v.optional(v.string()),
};

export async function settingsFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("settings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

// Null means "no stored preference yet", which leaves the client on its
// defaults rather than overwriting what the device is already showing.
export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const saved = await settingsFor(ctx, userId);
    if (!saved) return null;
    const { _id, _creationTime, userId: _owner, ...preferences } = saved;
    return preferences;
  },
});

export const update = mutation({
  args: fields,
  handler: async (ctx, patch) => {
    const userId = await requireUserId(ctx);
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(changes).length === 0) return;
    if (typeof changes.density === "number") {
      changes.density = Math.min(100, Math.max(0, Math.round(changes.density)));
    }
    const saved = await settingsFor(ctx, userId);
    if (saved) await ctx.db.patch(saved._id, changes);
    else await ctx.db.insert("settings", { userId, ...changes });
  },
});
