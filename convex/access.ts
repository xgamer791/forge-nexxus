import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
}

// Building needs an account. A guest row costs nothing to make, so anything
// that creates a site or moves credits refuses anonymous users; otherwise
// clearing storage would mint a fresh allowance.
export async function requireMemberId(ctx: QueryCtx | MutationCtx) {
  const userId = await requireUserId(ctx);
  const user = await ctx.db.get(userId);
  if (!user || user.isAnonymous) throw new ConvexError("Sign in to build");
  return userId;
}

export async function requireOwnedConversation(
  ctx: QueryCtx | MutationCtx,
  id: Id<"conversations">,
) {
  const userId = await requireUserId(ctx);
  const conversation = await ctx.db.get(id);
  if (!conversation || conversation.userId !== userId) {
    throw new ConvexError("Conversation not found");
  }
  return conversation;
}

export async function requireOwnedSite(ctx: QueryCtx | MutationCtx, id: Id<"sites">) {
  const userId = await requireUserId(ctx);
  const site = await ctx.db.get(id);
  if (!site || site.userId !== userId) throw new ConvexError("Site not found");
  return site;
}

export async function requireOwnedDomain(ctx: QueryCtx | MutationCtx, id: Id<"domains">) {
  const userId = await requireUserId(ctx);
  const domain = await ctx.db.get(id);
  if (!domain || domain.userId !== userId) throw new ConvexError("Domain not found");
  return domain;
}

export async function requireOwnedMemory(ctx: QueryCtx | MutationCtx, id: Id<"memories">) {
  const userId = await requireUserId(ctx);
  const memory = await ctx.db.get(id);
  if (!memory || memory.userId !== userId) throw new ConvexError("Memory not found");
  return memory;
}
