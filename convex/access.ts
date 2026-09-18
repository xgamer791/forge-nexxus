import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
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

export async function requireOwnedConnection(
  ctx: QueryCtx | MutationCtx,
  id: Id<"connections">,
) {
  const userId = await requireUserId(ctx);
  const connection = await ctx.db.get(id);
  if (!connection || connection.userId !== userId) {
    throw new ConvexError("Connection not found");
  }
  return connection;
}

export async function requireOwnedWorkspace(
  ctx: QueryCtx | MutationCtx,
  id: Id<"workspaces">,
) {
  const userId = await requireUserId(ctx);
  const workspace = await ctx.db.get(id);
  if (!workspace || workspace.userId !== userId) {
    throw new ConvexError("Workspace not found");
  }
  return workspace;
}
