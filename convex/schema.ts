import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { connectionKind, workspaceEnvironment, workspaceProtocol } from "./shapes";

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
  // Workspaces the user has added. Nothing is seeded: the sheets stay empty
  // until a connection exists, and `usedAt` orders the Recents list.
  connections: defineTable({
    userId: v.id("users"),
    kind: connectionKind,
    name: v.string(),
    detail: v.string(),
    connected: v.boolean(),
    usedAt: v.number(),
  }).index("by_user", ["userId"]),
  // Remote servers the user can open a shell on. Credentials live in `secret`
  // as ciphertext and are never returned to a client; everything else here is
  // metadata the workspace list renders.
  workspaces: defineTable({
    userId: v.id("users"),
    name: v.string(),
    protocol: workspaceProtocol,
    host: v.string(),
    port: v.number(),
    username: v.string(),
    environment: v.optional(workspaceEnvironment),
    authKind: v.union(v.literal("key"), v.literal("password")),
    secret: v.string(),
    connected: v.boolean(),
    lastConnectedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
  // Applications discovered on a server. Replaced wholesale by each scan, so
  // the list is whatever the server reported last, never a stale accumulation.
  // `active` marks the one workspace the app is currently working against.
  apps: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    path: v.string(),
    active: v.boolean(),
    scannedAt: v.number(),
    // Set the first time an app is chosen. A scan alone does not make an app
    // recent, so discovering fifty of them does not flood the Connect sheet.
    usedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),
  // Appearance choices follow the account rather than the device, so they
  // survive signing out and back in.
  settings: defineTable({
    userId: v.id("users"),
    theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    density: v.optional(v.number()),
    codeWrap: v.optional(v.boolean()),
    themedDiff: v.optional(v.boolean()),
    reduceTransparency: v.optional(v.boolean()),
    uiFont: v.optional(v.string()),
    codeFont: v.optional(v.string()),
  }).index("by_user", ["userId"]),
});
