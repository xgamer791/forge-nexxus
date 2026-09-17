import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  conversations: defineTable({
    userId: v.id("users"),
    title: v.string(),
    updatedAt: v.number(),
  }).index("by_user_updated", ["userId", "updatedAt"]),
  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    body: v.string(),
  }).index("by_conversation", ["conversationId"]),
});
