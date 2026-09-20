import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { requireMemberId } from "./access";
import { deleteConversation } from "./conversations";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";

const NAME_LIMIT = 80;

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
      isAnonymous: user.isAnonymous === true,
    };
  },
});

export const updateProfile = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await requireMemberId(ctx);
    const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
    if (!clean) throw new ConvexError("Enter a name");
    await ctx.db.patch(userId, { name: clean });
  },
});

// Which sign-in methods are linked to the account, for the Profile screen.
export const providers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    return [...new Set(accounts.map((account) => account.provider))].filter(
      (provider) => provider !== "anonymous",
    );
  },
});

// Deletes the account and everything it owns. The client signs out afterwards,
// since its tokens point at a session that no longer exists.
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireMemberId(ctx);
    await purgeUser(ctx, userId);
  },
});

export async function purgeUser(ctx: MutationCtx, userId: Id<"users">) {
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q) => q.eq("userId", userId))
    .collect();
  for (const conversation of conversations) await deleteConversation(ctx, conversation._id);
  const onboarding = await ctx.db.query("siteOnboarding").withIndex("by_user", q => q.eq("userId", userId)).collect();
  for (const row of onboarding) {
    if (row.briefStorageId) await ctx.storage.delete(row.briefStorageId);
    for (const asset of row.assets) await ctx.storage.delete(asset.storageId);
    await ctx.db.delete(row._id);
  }
  // Sites and domains went with their conversations; this sweeps up anything
  // that had lost its thread, plus the plan, the ledger, and preferences.
  const owned = [
    ...(await ctx.db.query("siteUploads").withIndex("by_user", q => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("sites").withIndex("by_user_updated", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("siteVersions").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("domains").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("subscriptions").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("creditLedger").withIndex("by_user_created", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("creditHolds").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
    ...(await ctx.db.query("settings").withIndex("by_user", (q) => q.eq("userId", userId)).collect()),
  ];
  await Promise.all(owned.map((row) => ctx.db.delete(row._id)));
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .collect();
    await Promise.all(codes.map((code) => ctx.db.delete(code._id)));
    await ctx.db.delete(account._id);
  }
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    await Promise.all(tokens.map((token) => ctx.db.delete(token._id)));
    await ctx.db.delete(session._id);
  }
  await ctx.db.delete(userId);
}
