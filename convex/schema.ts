import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { requestKind, storedPlanKey } from "./plans";

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
  // One design reference per site: the address SkillUI Ultra extracted it
  // from, the whole `.skill` package in file storage, the extract every
  // builder and auditor reads (`prompt`), the foundation stylesheet made from
  // its tokens, and the pages the page discovery agent chose (five at most).
  // A row from before SkillUI Ultra -- no `format`, or the retired measured
  // one -- keeps its address, so the site is extracted again there with no
  // new search.
  siteDesignPackages: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    storageId: v.id("_storage"),
    referenceUrl: v.string(),
    prompt: v.string(),
    inspectedPages: v.number(),
    buildEpoch: v.number(),
    createdAt: v.number(),
    format: v.optional(v.union(v.literal("forge-measured-v1"), v.literal("skillui-ultra-v1"))),
    routes: v.optional(v.array(v.string())),
    foundation: v.optional(v.string()),
  }).index("by_user", ["userId"]).index("by_site", ["siteId"]),
  // A build held for its design audit: the site as the builder last wrote it,
  // until the auditors agree it matches the SkillUI Ultra reference, send it
  // back, or stop it. A first build's pages were each audited by their crew
  // while they were written (`audited`), so it only lands here. The verdicts
  // stay after the site is gone, for `designGate:inspect`.
  designGates: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    runId: v.id("buildRuns"),
    source: v.union(v.literal("thread"), v.literal("onboarding")),
    assistantId: v.id("messages"),
    holdId: v.id("creditHolds"),
    requestKind,
    epoch: v.number(),
    onboardingId: v.optional(v.id("siteOnboarding")),
    attempt: v.optional(v.number()),
    rebuild: v.optional(v.boolean()),
    siteName: v.string(),
    prompt: v.optional(v.string()),
    remember: v.optional(v.boolean()),
    blockedNote: v.optional(v.string()),
    html: v.optional(v.string()),
    shell: v.optional(v.string()),
    pages: v.optional(v.array(v.object({ path: v.string(), title: v.string(), body: v.string() }))),
    summary: v.string(),
    // Every page already has its auditors' agreement: a first build, whose
    // crews audited each part as it was written.
    audited: v.optional(v.boolean()),
    status: v.union(
      v.literal("checking"),
      v.literal("reworking"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // Round 1 is the first check; each rework adds one.
    round: v.number(),
    // Steps in a row that came back with nothing to use.
    trouble: v.number(),
    // Why the last rework could not be used, for the next one to put right.
    problem: v.optional(v.string()),
    // The fixes the auditors sent back on the last round.
    fixes: v.array(v.string()),
    // Each round's outcome: whether every auditor agreed, and the parts that
    // did not, as `path part`. `lowest` is the retired layout check's score,
    // kept only on rows from before the auditors.
    results: v.array(v.object({
      round: v.number(),
      passed: v.boolean(),
      lowest: v.optional(v.number()),
      failing: v.array(v.string()),
      at: v.number(),
    })),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]).index("by_message", ["assistantId"]),
  // A first build or a rebuild, written a page at a time by a crew. Each page
  // has one builder and one auditor for its header, two of each for its body
  // and one of each for its footer; each part is saved here the moment its
  // builder writes it and again when its auditor answers, and the page is
  // kept only once every auditor agrees it matches the SkillUI Ultra
  // reference. Each step is an action of its own, and the next is queued the
  // moment one ends. Once every page is here the site lands (designGates,
  // `audited`), and the markup leaves this row.
  buildDrafts: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    onboardingId: v.id("siteOnboarding"),
    attempt: v.number(),
    runId: v.id("buildRuns"),
    // The build's own, for the hand-off to the design gate once every page is kept.
    assistantId: v.id("messages"),
    holdId: v.id("creditHolds"),
    epoch: v.number(),
    siteName: v.string(),
    rebuild: v.boolean(),
    // The SkillUI Ultra package the draft is written and audited against. A
    // step that finds the site holding any other package writes nothing.
    designId: v.id("siteDesignPackages"),
    designStorageId: v.id("_storage"),
    // What every step is told the same way: the model the draft began on, and
    // the member's memory note.
    model: v.string(),
    memory: v.optional(v.string()),
    // Every page the discovery agent chose (five at most), home first, and
    // the pages whose auditors have all agreed.
    routes: v.array(v.string()),
    shell: v.optional(v.string()),
    pages: v.array(v.object({ path: v.string(), title: v.string(), body: v.string() })),
    summary: v.optional(v.string()),
    // The crew on the current page. Every part keeps what its builder last
    // wrote and what its auditor last asked for.
    crew: v.optional(v.object({
      path: v.string(),
      parts: v.array(v.object({
        name: v.union(v.literal("header"), v.literal("body1"), v.literal("body2"), v.literal("footer")),
        // Unset until the builder has written. After the home page the header
        // and footer start as "": the shared ones as they stand, which their
        // auditors check on this page before anything is written for it.
        markup: v.optional(v.string()),
        // The page's title, as the builder for the top of the page named it.
        title: v.optional(v.string()),
        agreed: v.boolean(),
        // Audits run on this part so far, and replies in a row that could
        // not be used.
        round: v.number(),
        tries: v.number(),
        // What the auditor asked for last, for the builder's next go, and --
        // once the builder has made them -- for the auditor to check next.
        fixes: v.array(v.string()),
        asked: v.optional(v.array(v.string())),
        // Why the last reply for this part could not be used.
        problem: v.optional(v.string()),
        // The builder's reply as far as it got when its step's clock stopped
        // it part way, for the next step to carry on from that character.
        partial: v.optional(v.string()),
      })),
    })),
    // Retired: a page the old page-at-a-time writer's clock stopped part way.
    // Only drafts from before the crews carry it.
    partial: v.optional(v.object({ path: v.string(), text: v.string(), resumes: v.number() })),
    // Steps claimed so far, and steps in a row that moved nothing for any
    // reason but the step's own clock.
    step: v.number(),
    tries: v.number(),
    // Why the last reply could not be used, for the next step to put right.
    problem: v.optional(v.string()),
    // Where the last reply that stopped short had got to.
    lastStop: v.optional(v.object({
      reason: v.string(),
      phase: v.string(),
      reasoningChars: v.optional(v.number()),
      replyChars: v.optional(v.number()),
      at: v.number(),
    })),
    // The copy running the current step, and the draft's last sign of life.
    lease: v.optional(v.string()),
    beatAt: v.number(),
    // How many times the rescue has started a quiet step again.
    restarts: v.number(),
    status: v.union(v.literal("writing"), v.literal("done"), v.literal("failed"), v.literal("cancelled")),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_onboarding_attempt", ["onboardingId", "attempt"])
    .index("by_status_beat", ["status", "beatAt"]),
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
    // Which step of a queued attempt is under way. The platform can lose a
    // scheduled action across a deploy or a restart, so a step that goes
    // quiet is started again (onboarding.rescue); and a second copy of a step
    // -- a restart, a retry, a manual run -- does nothing while the first
    // still holds it. Only the attempt it names reads it.
    queueStep: v.optional(v.object({
      attempt: v.number(),
      step: v.union(v.literal("research"), v.literal("build")),
      // Set while one copy of the step holds it.
      lease: v.optional(v.string()),
      // The step's last sign of life: queued, claimed, or a heartbeat.
      beatAt: v.number(),
      // How many times the rescue has started this attempt's step again.
      restarts: v.number(),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]).index("by_site", ["siteId"]).index("by_status_updated", ["status", "updatedAt"]),
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
  // Every generation produces a complete site. Versions are kept so a bad edit
  // can be walked back and a published build stays put while the draft moves
  // on.
  //
  // A site is stored as a shell and its pages: `shell` is what every page
  // shares -- head, stylesheet, nav, footer -- and each `pages` entry is the
  // markup for one address. `convex/pages.ts` puts them back together.
  //
  // `html` is what a build produced before pages existed: one document, which
  // is that site's home page and its only one. It stays here, and stays
  // optional alongside the other two, so every version already published goes
  // on serving exactly what it served. Nothing is backfilled.
  siteVersions: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    html: v.optional(v.string()),
    shell: v.optional(v.string()),
    pages: v.optional(
      v.array(v.object({ path: v.string(), title: v.string(), body: v.string() })),
    ),
    summary: v.string(),
    requestKind: v.string(),
    // The Awwwards originals the header, the dropdown menu and the footer were
    // cloned from, as the design agent named them. Absent on builds from
    // before the design reviewer.
    clones: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_site", ["siteId"])
    .index("by_user", ["userId"]),
  // The second agent's check on a build's header, dropdown menu and footer. A
  // build that needs one parks its site here instead of saving it: the design
  // reviewer reads it and either lets it through to be saved or sends it back
  // to the design agent with fixes, until it agrees or the rounds run out.
  // The site is cleared from the row once the check ends; the verdicts stay
  // for `designReview:inspect`. Nothing here is shown to a member.
  designReviews: defineTable({
    userId: v.id("users"),
    siteId: v.id("sites"),
    runId: v.id("buildRuns"),
    source: v.union(v.literal("thread"), v.literal("onboarding")),
    assistantId: v.id("messages"),
    holdId: v.id("creditHolds"),
    requestKind,
    epoch: v.number(),
    // An onboarding build's own: which attempt this is, and whether it is a
    // rebuild that owes the member new pictures.
    onboardingId: v.optional(v.id("siteOnboarding")),
    attempt: v.optional(v.number()),
    rebuild: v.optional(v.boolean()),
    // A thread turn's own: what was asked, for the memory note once it lands.
    siteName: v.string(),
    prompt: v.optional(v.string()),
    remember: v.optional(v.boolean()),
    blockedNote: v.optional(v.string()),
    // The site under review, as the design agent last wrote it.
    html: v.optional(v.string()),
    shell: v.optional(v.string()),
    pages: v.optional(v.array(v.object({ path: v.string(), title: v.string(), body: v.string() }))),
    summary: v.string(),
    clones: v.optional(v.string()),
    status: v.union(
      v.literal("checking"),
      v.literal("revising"),
      v.literal("passed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // Round 1 is the first check; every rework the reviewer asks for adds one.
    round: v.number(),
    // Steps in a row that came back with nothing to use.
    trouble: v.number(),
    fixes: v.array(v.string()),
    // Why the last rework could not be used, for the next one to put right.
    problem: v.optional(v.string()),
    verdicts: v.array(v.object({
      round: v.number(),
      equal: v.boolean(),
      header: v.boolean(),
      menu: v.boolean(),
      footer: v.boolean(),
      originals: v.array(v.string()),
      fixes: v.array(v.string()),
      at: v.number(),
    })),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_message", ["assistantId"])
    .index("by_onboarding_attempt", ["onboardingId", "attempt"]),
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
      v.literal("researching"),
      v.literal("calling"),
      v.literal("reviewing"),
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
      reasoningChars: v.optional(v.number()),
      finishReason: v.optional(v.string()),
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
      // How a reply was read and where it had got to when it stopped. Counts and
      // phases only: never the thinking, the prompt or the page.
      stream: v.optional(v.boolean()),
      stopReason: v.optional(v.string()),
      streamPhase: v.optional(v.string()),
      chunks: v.optional(v.number()),
      keepAlives: v.optional(v.number()),
      bytes: v.optional(v.number()),
      firstTokenMs: v.optional(v.number()),
      firstContentMs: v.optional(v.number()),
      sinceTokenMs: v.optional(v.number()),
      sinceEventMs: v.optional(v.number()),
      completionTokens: v.optional(v.number()),
      reasoningTokens: v.optional(v.number()),
      providerError: v.optional(v.string()),
      city: v.optional(v.string()),
      page: v.optional(v.number()),
      total: v.optional(v.number()),
      mode: v.optional(v.string()),
      screens: v.optional(v.number()),
      loopRepeats: v.optional(v.number()),
      // Which round of the design check an event belongs to.
      round: v.optional(v.number()),
      // A build written a page at a time: the page an event is about, and the
      // step that wrote it.
      path: v.optional(v.string()),
      step: v.optional(v.number()),
      // Which part of the page a crew event is about (header, body1, body2,
      // footer), and whether its auditor agreed.
      part: v.optional(v.string()),
      agree: v.optional(v.boolean()),
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
    // Which screen the desktop preview shows a site on.
    previewDevice: v.optional(v.union(v.literal("iphone"), v.literal("iphone-max"), v.literal("pixel"), v.literal("ipad"), v.literal("desktop"))),
  }).index("by_user", ["userId"]),
});
