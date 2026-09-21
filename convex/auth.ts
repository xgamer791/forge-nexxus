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

// Where a provider is allowed to send someone back to. Convex Auth resolves
// this inside its OAuth callback *before* that handler's try/catch, so a throw
// here is a 500 on the way home instead of a trip back to the app — and its
// own default throws on anything it does not recognise. Nothing unrecognised
// is followed; it falls back to SITE_URL, which is also the safe answer for an
// address someone else supplied.
export function resolveRedirect(redirectTo: unknown): string {
  const base = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
  if (typeof redirectTo !== "string" || redirectTo === "") return base;
  if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) return `${base}${redirectTo}`;
  if (!base) return base;
  // A prefix match alone would accept `https://site.example.evil.com`.
  if (redirectTo === base || redirectTo.startsWith(`${base}/`) || redirectTo.startsWith(`${base}?`)) {
    return redirectTo;
  }
  return base;
}

const convex = convexAuth({
  callbacks: {
    redirect: async ({ redirectTo }) => resolveRedirect(redirectTo),
  },
  providers: [
    Anonymous,
    Resend({
      from: process.env.AUTH_EMAIL_FROM ?? "Forge Nexxus <onboarding@resend.dev>",
    }),
    // Google signs you straight back into whichever account the browser is
    // already holding unless it is asked to offer the chooser, which makes
    // adding a second account impossible.
    Google({ authorization: { params: { prompt: "select_account" } } }),
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

// Every sign-in passes through here so a guest's data follows them to the
// account they just signed in to, whichever provider issued it, and so a
// member has a plan from the first moment the app can ask about one.
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
    // Convex Auth has already minted the session by the line above. Everything
    // below is our own bookkeeping, and none of it is worth the sign-in it
    // would take down with it: a throw here discarded the tokens and left
    // someone who had just authenticated back at the front door, with no way
    // past it and nothing said about why. Both of these run on the member path
    // only — a guest has no email and `billing.ensure` returns early for an
    // anonymous row — so a fault in either was invisible until the moment
    // someone signed in for real. Record it and hand the session over; every
    // path that touches a subscription calls `ensureCurrent` anyway, so the
    // plan lands on the next request regardless.
    if (guestId && userId && userId !== guestId) {
      try {
        await ctx.runMutation(internal.auth.adoptGuest, { guestId, userId });
      } catch (error) {
        console.error("Sign-in: could not move guest data to the account", error);
      }
    }
    if (userId) {
      try {
        await ctx.runMutation(internal.billing.ensure, { userId });
      } catch (error) {
        console.error("Sign-in: could not open a subscription for the account", error);
      }
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
  // Guests cannot build, so these are normally empty; carrying them keeps the
  // rule that nothing a user made is left behind on the guest row.
  const sites = await ctx.db
    .query("sites")
    .withIndex("by_user_updated", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(sites.map((site) => ctx.db.patch(site._id, { userId })));
  const domains = await ctx.db
    .query("domains")
    .withIndex("by_user", (q) => q.eq("userId", guestId))
    .collect();
  await Promise.all(domains.map((domain) => ctx.db.patch(domain._id, { userId })));
  const onboarding = await ctx.db.query("siteOnboarding").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(onboarding.map(row => ctx.db.patch(row._id, { userId })));
  const uploads = await ctx.db.query("siteUploads").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(uploads.map(row => ctx.db.patch(row._id, { userId })));
  const images = await ctx.db.query("siteImages").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(images.map(row => ctx.db.patch(row._id, { userId })));
  const buildRuns = await ctx.db.query("buildRuns").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(buildRuns.map(row => ctx.db.patch(row._id, { userId })));
  const buildEvents = await ctx.db.query("buildEvents").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(buildEvents.map(row => ctx.db.patch(row._id, { userId })));
  const memories = await ctx.db.query("memories").withIndex("by_user", q => q.eq("userId", guestId)).collect();
  await Promise.all(memories.map(row => ctx.db.patch(row._id, { userId })));
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
