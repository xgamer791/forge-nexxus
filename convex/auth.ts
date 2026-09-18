import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "./_generated/server";
import { settingsFor } from "./settings";

const convex = convexAuth({
  providers: [
    Anonymous,
    Resend({
      from: process.env.AUTH_EMAIL_FROM ?? "Forge Nexxus <onboarding@resend.dev>",
    }),
    Google,
    Apple,
  ],
});

export const { auth, signOut, store, isAuthenticated } = convex;
export const signInWithConvexAuth = convex.signIn;

type SignInResult = {
  tokens?: { token: string; refreshToken: string } | null;
  redirect?: string;
  verifier?: string;
  started?: boolean;
};

// Every sign-in passes through here so a guest's conversations follow them to
// the account they just signed in to, whichever provider issued it.
export const signIn = action({
  args: {
    provider: v.optional(v.string()),
    params: v.optional(v.any()),
    verifier: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    calledBy: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SignInResult> => {
    const guestId = await getAuthUserId(ctx);
    const result: SignInResult = await ctx.runAction(api.auth.signInWithConvexAuth, args);
    const userId = result.tokens?.token ? userIdFromToken(result.tokens.token) : null;
    if (guestId && userId && userId !== guestId) {
      await ctx.runMutation(internal.auth.adoptGuest, { guestId, userId });
    }
    return result;
  },
});

export const adoptGuest = internalMutation({
  args: { guestId: v.id("users"), userId: v.id("users") },
  handler: async (ctx, { guestId, userId }) => {
    const guest = await ctx.db.get(guestId);
    if (!guest?.isAnonymous || !(await ctx.db.get(userId))) return;
    await adoptGuestData(ctx, guestId, userId);
  },
});

export async function adoptGuestData(
  ctx: MutationCtx,
  guestId: Id<"users">,
  userId: Id<"users">,
) {
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(conversations.map((c) => ctx.db.patch(c._id, { userId })));
  const connections = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", guestId))
    .collect();
  const owned = await ctx.db
    .query("connections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  await Promise.all(
    connections.map((connection) => {
      const alreadyThere = owned.some(
        (item) => item.kind === connection.kind && item.detail === connection.detail,
      );
      return alreadyThere
        ? ctx.db.delete(connection._id)
        : ctx.db.patch(connection._id, { userId });
    }),
  );
  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_user", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(workspaces.map((workspace) => ctx.db.patch(workspace._id, { userId })));
  // Appearance choices made as a guest carry over only when the account has
  // none of its own; an existing account keeps what it already saved.
  const guestSettings = await settingsFor(ctx, guestId);
  if (guestSettings) {
    const accountSettings = await settingsFor(ctx, userId);
    if (accountSettings) await ctx.db.delete(guestSettings._id);
    else await ctx.db.patch(guestSettings._id, { userId });
  }
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(accounts.map((a) => ctx.db.delete(a._id)));
  await ctx.db.delete(guestId);
}

function userIdFromToken(token: string): Id<"users"> | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const subject = String(JSON.parse(atob(payload)).sub ?? "");
    const [userId] = subject.split("|");
    return userId ? (userId as Id<"users">) : null;
  } catch {
    return null;
  }
}
