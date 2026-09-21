import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { storedPlanKey } from "./plans";

export default defineSchema({
  ...authTables,
  siteUploads: defineTable({
    userId: v.id("users"),
    onboardingId: v.id("siteOnboarding"),
    storageId: v.id("_storage"),
  }).index("by_user", ["userId"]).index("by_onboarding", ["onboardingId"]).index("by_storage", ["storageId"]),
  // Pictures the image model made for a site. The page points at the stored
  // file; this row is what lets it go when the site or the account does.
  siteImages: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    storageId: v.id("_storage"),
    prompt: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]).index("by_site", ["siteId"]),
  siteOnboarding: defineTable({
    userId: v.id("users"),
    siteId: v.optional(v.id("sites")),
    answers: v.array(v.string()),
    step: v.number(),
    revision: v.number(),
    strategyAnswers: v.optional(v.array(v.union(v.string(), v.null()))),
    strategy: v.optional(v.string()),
    strategyRevision: v.optional(v.number()),
    // One-way duplicate checks only. Never include these in a provider prompt.
    discardedDesignHashes: v.optional(v.array(v.string())),
    discardedStyleSignatures: v.optional(v.array(v.array(v.string()))),
    briefStorageId: v.optional(v.id("_storage")),
    assets: v.array(v.object({ storageId: v.id("_storage"), name: v.string(), type: v.string() })),
    status: v.union(v.literal("questions"), v.literal("queued"), v.literal("building"), v.literal("saving"), v.literal("complete"), v.literal("failed")),
    attempt: v.number(),
    dismissed: v.boolean(),
    error: v.optional(v.string()),
    holdId: v.optional(v.id("creditHolds")),
    assistantId: v.optional(v.id("messages")),
    events: v.array(v.object({ label: v.string(), at: v.number() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]).index("by_site", ["siteId"]),
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
    // Bumped when a member cancels an in-flight build, so a provider call
    // that finishes later cannot save a page they already discarded.
    buildEpoch: v.optional(v.number()),
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
  // One row per building-agent turn. The member can subscribe to it, and an
  // operator can inspect it, so a hung or looping build is visible without
  // reading Convex logs. Nothing here is a prompt, a key, or HTML.
  buildRuns: defineTable({
    userId: v.id("users"),
    siteId: v.optional(v.id("sites")),
    conversationId: v.optional(v.id("conversations")),
    onboardingId: v.optional(v.id("siteOnboarding")),
    messageId: v.optional(v.id("messages")),
    holdId: v.optional(v.id("creditHolds")),
    attempt: v.optional(v.number()),
    source: v.union(v.literal("generate"), v.literal("onboarding"), v.literal("rebuild")),
    requestKind: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("started"),
      v.literal("calling"),
      v.literal("images"),
      v.literal("saving"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    startedAt: v.number(),
    updatedAt: v.number(),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    errorClass: v.optional(v.string()),
    providerHost: v.optional(v.string()),
    providerModel: v.optional(v.string()),
    providerLabel: v.optional(v.string()),
    keySet: v.optional(v.boolean()),
    misrouted: v.optional(v.boolean()),
    promptChars: v.optional(v.number()),
    htmlChars: v.optional(v.number()),
    imageWanted: v.optional(v.number()),
    imageMade: v.optional(v.number()),
    creditsHeld: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_started", ["userId", "startedAt"])
    .index("by_site", ["siteId"])
    .index("by_conversation", ["conversationId"])
    .index("by_onboarding", ["onboardingId"])
    .index("by_onboarding_attempt", ["onboardingId", "attempt"])
    .index("by_message", ["messageId"])
    .index("by_started", ["startedAt"]),
  buildEvents: defineTable({
    userId: v.id("users"),
    runId: v.id("buildRuns"),
    at: v.number(),
    phase: v.string(),
    level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    label: v.string(),
    detail: v.optional(v.object({
      httpStatus: v.optional(v.number()),
      durationMs: v.optional(v.number()),
      attempt: v.optional(v.number()),
      continuation: v.optional(v.number()),
      truncated: v.optional(v.boolean()),
      tokensAsked: v.optional(v.number()),
      replyChars: v.optional(v.number()),
      promptChars: v.optional(v.number()),
      htmlChars: v.optional(v.number()),
      imageWanted: v.optional(v.number()),
      imageMade: v.optional(v.number()),
      errorClass: v.optional(v.string()),
      host: v.optional(v.string()),
      model: v.optional(v.string()),
      keySet: v.optional(v.boolean()),
      misrouted: v.optional(v.boolean()),
      requestKind: v.optional(v.string()),
      holdStatus: v.optional(v.string()),
      creditAmount: v.optional(v.number()),
      timedOut: v.optional(v.boolean()),
    })),
  })
    .index("by_run", ["runId"])
    .index("by_run_at", ["runId", "at"])
    .index("by_user", ["userId"])
    .index("by_user_at", ["userId", "at"]),
  // What Forge remembers about a member between conversations: short facts
  // they shared, kept across every site they build. The server writes a row
  // after a turn; Settings lists and forgets them. Never a page or a key.
  memories: defineTable({
    userId: v.id("users"),
    text: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
  // Appearance choices and the memory switch follow the account rather than
  // the device, so they survive signing out and back in.
  settings: defineTable({
    userId: v.id("users"),
    theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    density: v.optional(v.number()),
    codeWrap: v.optional(v.boolean()),
    themedDiff: v.optional(v.boolean()),
    reduceTransparency: v.optional(v.boolean()),
    uiFont: v.optional(v.string()),
    codeFont: v.optional(v.string()),
    // Unset means on. Off stops Forge reading and adding memories; what is
    // saved stays until the member forgets it.
    memory: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),
});
