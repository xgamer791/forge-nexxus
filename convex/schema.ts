import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { storedPlanKey } from "./plans";

export default defineSchema({
  ...authTables,
  // A site is the thing a user builds. Its conversation is the build thread —
  // every prompt about the site lives there — so deleting the site deletes the
  // thread with it. Nothing is seeded: the drawer is empty until one is made.
  sites: defineTable({
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    name: v.string(),
    status: v.union(v.literal("draft"), v.literal("published")),
    createdAt: v.number(),
    updatedAt: v.number(),
    // The latest build, and the build the public URL serves. A slug is
    // assigned on first publish and kept so the address never changes.
    currentVersionId: v.optional(v.id("siteVersions")),
    publishedVersionId: v.optional(v.id("siteVersions")),
    slug: v.optional(v.string()),
    // Picking the first address does not spend the rename. Once an existing
    // address moves, this records that the site's one rename has been used.
    slugChangedAt: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
  })
    .index("by_user_updated", ["userId", "updatedAt"])
    .index("by_conversation", ["conversationId"])
    .index("by_slug", ["slug"]),
  // Every generation produces a complete single-file site. Versions are kept
  // so a bad edit can be walked back and a published build stays put while
  // the draft moves on.
  siteVersions: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    html: v.string(),
    summary: v.string(),
    requestKind: v.string(),
    createdAt: v.number(),
  })
    .index("by_site", ["siteId"])
    .index("by_user", ["userId"]),
  conversations: defineTable({
    userId: v.id("users"),
    title: v.string(),
    updatedAt: v.number(),
  }).index("by_user_updated", ["userId", "updatedAt"]),
  messages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    body: v.string(),
    // An assistant message is `pending` while its build runs and `failed` if
    // the build did not produce a site; a finished one points at its version.
    status: v.optional(v.union(v.literal("pending"), v.literal("failed"))),
    versionId: v.optional(v.id("siteVersions")),
  }).index("by_conversation", ["conversationId"]),
  // Custom domains pointed at a site. A domain is `pending` from the moment it
  // is added until hosting has verified its DNS.
  domains: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    hostname: v.string(),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    createdAt: v.number(),
    // What the last DNS check saw. `note` is what the user is told to fix.
    checkedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    note: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_site", ["siteId"])
    // A visitor arrives by hostname, so serving a custom domain is one lookup.
    .index("by_hostname", ["hostname"]),
  // One row per member: the plan they are on and this period's credits.
  // `credits` is what the period has left and `reserved` is held by requests
  // still running. Both go back to the plan's allowance when the period ends;
  // nothing rolls over, top-ups included.
  subscriptions: defineTable({
    userId: v.id("users"),
    planKey: storedPlanKey,
    periodStart: v.number(),
    periodEnd: v.number(),
    credits: v.number(),
    reserved: v.number(),
    // What the period opened with plus its top-ups; the meter's full mark.
    granted: v.number(),
    cancelAtPeriodEnd: v.boolean(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
  // Stripe deliveries already applied, so a redelivery can never grant twice.
  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    receivedAt: v.number(),
  }).index("by_event", ["eventId"]),
  // Append-only record of every credit movement, so a balance can always be
  // explained. `amount` is signed and `balanceAfter` is what was left.
  creditLedger: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("grant"),
      v.literal("topup"),
      v.literal("spend"),
      v.literal("refund"),
      v.literal("expire"),
      v.literal("adjust"),
    ),
    amount: v.number(),
    balanceAfter: v.number(),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_user_created", ["userId", "createdAt"]),
  // Credits held by a request that has started but not finished. Settling
  // turns a hold into a spend; releasing gives it back.
  creditHolds: defineTable({
    userId: v.id("users"),
    requestKind: v.string(),
    amount: v.number(),
    status: v.union(v.literal("held"), v.literal("settled"), v.literal("released")),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
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
