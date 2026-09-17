import Resend from "@auth/core/providers/resend";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Anonymous,
    Resend({
      from: process.env.AUTH_EMAIL_FROM ?? "Forge Nexxus <onboarding@resend.dev>",
    }),
  ],
  callbacks: {
    // A guest who signs in with email keeps their conversations.
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      const guestId = await getAuthUserId(ctx);
      if (!guestId || guestId === userId) return;
      const guest = await ctx.db.get(guestId);
      if (!guest?.isAnonymous) return;
      await adoptGuestData(ctx, guestId, userId);
    },
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
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(accounts.map((a) => ctx.db.delete(a._id)));
  await ctx.db.delete(guestId);
}
