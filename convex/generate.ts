import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { creditCheck, currentPlan, holdCredits, releaseHold, settleHold } from "./billing";
import { closeRun, providerTrace, type ProviderTrace } from "./diagnostics";
import { fulfilImages, IMAGE_MODEL_LABEL, imageRoute, wantsImages } from "./images";
import { briefFile } from "./onboardingQuestions";
import { FORGE_MD } from "./forgeMd";
import { FRONTEND_DESIGN } from "./frontendDesign";
import { REQUEST_COSTS, requestKind, type RequestKind } from "./plans";
import { publishBuild } from "./sites";

// How much of the thread the model sees, and how long a page it may write.
// A whole site — a products section included — is a great deal more output
// than a conversational reply, so a build is given its own ceiling. A
// provider whose own cap is lower says so, and `complete` retries inside it.
const HISTORY_LIMIT = 32;
const DEFAULT_MAX_TOKENS = 16000;
const BUILD_MAX_TOKENS = 24000;
// What to drop to when a provider refuses the length without naming its cap.
const SAFE_MAX_TOKENS = 8192;
const REASON_LIMIT = 300;
// A conversational reply is the message itself, so it gets far more room than
// the one-line summary that rides along with a build.
const TALK_LIMIT = 4000;

// Where conversation and site building go when the deployment says nothing.
// `AI_BASE_URL`, `AI_MODEL`, `AI_BUILD_MODEL` and `AI_API_KEY` name the real
// route; any provider that speaks the OpenAI chat shape works, Google's
// `/v1beta/openai` path included. Pictures have a route of their own in
// `images.ts`, and text never goes to it.
const CHAT_BASE_URL = "https://api.deepseek.com/v1";
const CHAT_MODEL = "deepseek-flash";
const CHAT_MODEL_LABEL = "DeepSeek V4.1 Flash";

// How many new pictures one reply may ask for. A first build carries a hero
// and then whatever the page is actually about — products need one each, and
// a grid where only the first few resolved is what a half-finished site looks
// like. Every picture is its own held-and-settled `image` request, so this is
// a ceiling rather than a spend: a page that wants fewer costs less.
export const BUILD_IMAGE_LIMIT = 6;
const EDIT_IMAGE_LIMIT = 2;

// One call may run long -- a whole site is a lot of tokens -- but a build as a
// whole has to finish inside an action's ten minutes with room for pictures.
const CALL_TIMEOUT_MS = 240000;
const TEXT_BUDGET_MS = 400000;
const CONTINUE_FLOOR_MS = 45000;
const MAX_CONTINUATIONS = 2;
const MAX_COMPLETE_LOOPS = 5;
const RETRY_WAIT_MS = 1500;
// A thread build that the platform stops -- past ten minutes, out of memory --
// never reaches its own catch, so this is what gives its credits back and
// tells the thread. It sits past the action's limit so it can only ever speak
// for a build that is already gone.
const RUN_WATCHDOG_MS = 610000;

// The route a turn takes. Writing a whole website is the hardest thing the
// agent does and a conversational reply is the cheapest, so a deployment may
// point builds at a stronger model with `AI_BUILD_MODEL` and leave chat on
// `AI_MODEL`. Unset, a build runs on exactly the model chat does, so nothing
// changes for a deployment that has not chosen.
export function chatRoute(purpose: "chat" | "build" = "chat") {
  const baseUrl = (process.env.AI_BASE_URL?.trim() || CHAT_BASE_URL).replace(/\/+$/, "");
  const model =
    (purpose === "build" ? process.env.AI_BUILD_MODEL?.trim() : "") ||
    process.env.AI_MODEL?.trim() ||
    CHAT_MODEL;
  return {
    baseUrl,
    model,
    apiKey: process.env.AI_API_KEY,
    // What the agent says it runs on. The marketing name belongs to exactly
    // one model id, so any other id reports itself rather than borrowing it:
    // `deepseek-chat` is not "V4.1 Flash", and saying so would be a guess.
    label: process.env.AI_MODEL_LABEL?.trim() || (model === CHAT_MODEL ? CHAT_MODEL_LABEL : model),
  };
}

// Which model each kind of work goes to, for whoever runs the deployment:
// `npx convex run generate:routing`. Names and hosts only, never a key.
export const routing = internalQuery({
  args: {},
  handler: async () => {
    const chat = chatRoute();
    const build = chatRoute("build");
    const image = imageRoute();
    return {
      chat: { host: new URL(chat.baseUrl).host, model: chat.model, label: chat.label, keySet: Boolean(chat.apiKey) },
      build: { host: new URL(build.baseUrl).host, model: build.model, label: build.label, sameAsChat: build.model === chat.model },
      image: { host: new URL(image.baseUrl).host, model: image.model, label: IMAGE_MODEL_LABEL, keySet: Boolean(image.apiKey), pinnedToLite: image.pinned },
    };
  },
});

function systemPrompt(imageLimit: number, purpose: "chat" | "build") {
  const pictures = imageRoute().apiKey
    ? `IMAGES — pictures are made for you by an image model after you reply.
- Where a photograph or illustration genuinely helps (the hero, the offer, the place, the people, the work), write an img whose src is forge-image: followed by a number, and describe the picture in data-forge-image, like this: <img src="forge-image:1" data-forge-image="Morning light across the counter of a small neighbourhood bakery, sourdough loaves in the foreground, warm and unposed, editorial photograph" data-forge-aspect="16:9" alt="Sourdough loaves on the counter" width="1600" height="900">
- Write each description as art direction: subject, setting, light, mood and style, in keeping with the site's palette. No text, logos or watermarks in the picture. data-forge-aspect is one of 1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16.
- Ask for at most ${imageLimit} new pictures in one reply, and make each one earn its place. Style every img so the layout holds before it loads: display:block and width:100%, with height:auto or an aspect-ratio and object-fit:cover.
- An img whose src is already an https or data address is finished: keep its src exactly as it is and do not describe it again. Image addresses supplied in the saved brief may be used as they are. Never link to any other external image; everything else is CSS gradients, inline SVG and colour.`
    : `IMAGES — pictures cannot be made on this turn. Use CSS gradients, inline SVG and colour blocks for imagery and give every visual a purpose. Keep any img that already has an https or data address exactly as it is, use image addresses supplied in the saved brief as they are, never write forge-image, and never link to any other external image.`;
  return `You are Forge, the website-building agent inside Forge Nexxus: a senior web designer, copywriter and front-end developer in one. People describe what they want in plain language and you hand back a finished website.

You give one of two kinds of reply, and what the user asked for decides which.

BUILD — when they describe a site to make, or ask for a change to the page.
Return one self-contained HTML file:
- A full document (<!doctype html> … </html>) with a lang, a <title>, a meta description, a meta viewport, and all CSS in one <style> block in the <head>.
- Structure it as a real site, not a poster: a header with the name and a nav that links to every section; a hero that says what this is, who it is for and the one action to take; then the sections this business needs; then a closing call to action with whatever contact details were supplied, and a footer. Every nav link points at a section id that exists.
- The sections in the middle are decided by what the brief says the site has to do, not by a running order. A business that sells products gets a products section — one block per line of the catalogue the brief supplies, with its name, what it is, its price where that line carries one, and an action — as surely as one that takes bookings gets a booking section. Cover every job the brief names; then add what this business needs to be understood: what it offers, why it is different, how it works, about.
- The main action a visitor should take appears in the hero, again after the offer, and in the closing section, always in the same words.
- Design with intent: one palette built from their brand or the feel they asked for, with accessible contrast; one typeface for the whole site, with a clear scale built from its weights and sizes; generous whitespace; one radius and spacing rhythm; layouts that change from section to section rather than one card grid repeated.
- Mobile-first and responsive from 320px to a wide desktop, with CSS grid and flexbox, fluid type through clamp(), and a nav that stays usable on a phone without JavaScript — let it wrap or scroll sideways, never hide it behind a script.
- Semantic landmarks (header, nav, main, section, footer), one h1, headings in order, alt text on every image, visible :focus-visible styles, and a prefers-reduced-motion rule if anything moves.
- Real, specific copy written for this business from what they told you — never lorem ipsum or "[placeholder]". Use the prices, addresses, phone numbers and names the brief supplies, and leave out testimonials, statistics, awards and team members it does not.
- No scripts and no frameworks, so build the surface honestly rather than faking what sits behind it. A shop still gets its products, a booking business still gets its booking section, and a form is static markup. Their actions lead somewhere true — an anchor to the contact section, or an external store or booking link the brief supplies. Never render a cart, a checkout, a payment form, a signed-in account or a confirmed order as though it worked.
- Links between sections use anchors. Google Fonts and Fontshare are the only external stylesheets, and they load the one family.

${pictures}

Reply with one sentence saying what you built or changed, then the complete HTML in a single \`\`\`html code block, and nothing after it. When the user asks for a change, apply it to the current file and return the whole updated file, keeping everything they did not ask to change.

TALK — when they ask a question, want an opinion, or are still working out what they want.
Reply in plain prose: short, concrete, and about their site. Do not return HTML, and do not open a code block of any kind. Say what you would do and offer to make the change, rather than making it. A build costs the user credits and a reply like this barely does, so do not rebuild the page to answer a question.

IDENTITY — if someone asks which AI or model you are, say it plainly in one sentence and get back to their site: this turn runs on ${chatRoute(purpose).label}, and the pictures on a site are made by ${IMAGE_MODEL_LABEL}. Those two names are all you know: never guess at a model's family, version, maker or abilities beyond them, and never claim to be or not to be some other company's model.

Never ask the user questions or append a follow-up question. For an ambiguous request, use the saved website brief and sensible design defaults. Never invent missing business facts. Keep strategy private. If the request is clearly about creating or changing a website, build it.`;
}

// What the thread shows while the request runs. The server picks it, because
// the server is what knows whether this turn can build: promising to build a
// site to someone whose balance only covers a conversation is a lie the client
// cannot help telling on its own.
const PENDING_LABELS: Record<RequestKind, string> = {
  chat: "Thinking…",
  generate: "Building your site…",
  edit: "Updating your site…",
  image: "Making an image…",
  video: "Making a video…",
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// One prompt in, one build out. The credits are held before the provider is
// called and settled or released after, so a failed build costs nothing and a
// burst of prompts cannot outrun the balance.
export const run = action({
  args: { conversationId: v.id("conversations"), prompt: v.string() },
  handler: async (ctx, { conversationId, prompt }): Promise<{ messageId: Id<"messages"> }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const text = prompt.trim();
    if (!text) throw new ConvexError("Describe what you want first");
    const runId = await ctx.runMutation(internal.diagnostics.open, {
      userId,
      conversationId,
      source: "generate",
      promptChars: text.length,
    });
    let assistantId: Id<"messages"> | undefined;
    let holdId: Id<"creditHolds"> | undefined;
    try {
      const job = await ctx.runMutation(internal.generate.begin, { userId, conversationId, prompt: text });
      assistantId = job.assistantId;
      holdId = job.holdId;
      const purpose = job.requestKind === "chat" ? "chat" : "build";
      const route = chatRoute(purpose);
      let providerHost = route.baseUrl;
      try { providerHost = new URL(route.baseUrl).host; } catch { /* keep the raw base if it is not a URL */ }
      await ctx.runMutation(internal.diagnostics.attach, {
        runId,
        siteId: job.siteId,
        conversationId,
        messageId: job.assistantId,
        holdId: job.holdId,
        requestKind: job.requestKind,
        providerHost,
        providerModel: route.model,
        providerLabel: route.label,
        keySet: Boolean(route.apiKey),
        status: "calling",
      });
      const trace = providerTrace(ctx, runId, userId);
      await trace.note({
        phase: "held",
        label: job.requestKind === "chat" ? "Credits held for a conversation" : "Credits held for a build",
        detail: {
          requestKind: job.requestKind,
          host: providerHost,
          model: route.model,
          keySet: Boolean(route.apiKey),
          },
      });
      const reply = await callProvider(job.messages, undefined, undefined, trace, purpose);
      const parsed = parseReply(reply);
      // The pictures a page asked for are made before it is stored, so the
      // version that lands never points at anything that does not exist. A page
      // that came back on a talk-only turn is about to be dropped: it gets none.
      let imageWanted = 0;
      let imageMade = 0;
      let html = parsed.html ?? undefined;
      if (parsed.html && job.requestKind !== "chat") {
        if (wantsImages(parsed.html)) {
          await trace.note({ phase: "images", label: "Making pictures", status: "images" });
        }
        const pictures = await fulfilImages(ctx, { html: parsed.html, userId, siteId: job.siteId, limit: job.imageLimit });
        html = pictures.html;
        imageWanted = pictures.wanted;
        imageMade = pictures.made;
        if (pictures.wanted) {
          await trace.note({
            phase: "images_done",
            label: pictures.made ? "Pictures made for your site" : "No new pictures to make",
            detail: { imageWanted: pictures.wanted, imageMade: pictures.made },
          });
        }
      }
      await trace.note({
        phase: "saving",
        label: job.requestKind === "chat" ? "Saving the reply" : "Saving your website",
        status: "saving",
        detail: { htmlChars: html?.length, requestKind: job.requestKind },
      });
      const finished = await ctx.runMutation(internal.generate.finish, {
        assistantId: job.assistantId,
        siteId: job.siteId,
        holdId: job.holdId,
        requestKind: job.requestKind,
        html,
        summary: parsed.summary,
        blockedNote: job.blockedNote,
        epoch: job.epoch,
      });
      if (finished === "cancelled") {
        await ctx.runMutation(internal.diagnostics.close, {
          runId,
          status: "failed",
          error: "Build cancelled",
        });
        return { messageId: job.assistantId };
      }
      await ctx.runMutation(internal.diagnostics.close, {
        runId,
        status: "complete",
        htmlChars: html?.length,
        imageWanted,
        imageMade,
      });
    } catch (error) {
      const reason = describe(error);
      if (assistantId && holdId) {
        await ctx.runMutation(internal.generate.fail, { assistantId, holdId, reason });
      }
      try {
        await ctx.runMutation(internal.diagnostics.close, { runId, status: "failed", error: reason });
      } catch {
        /* A failed close must not hide the build error. */
      }
      throw new ConvexError(reason);
    }
    return { messageId: assistantId! };
  },
});

// Records the prompt, holds the credits, and hands the action everything the
// model needs, all in one transaction.
export const begin = internalMutation({
  args: { userId: v.id("users"), conversationId: v.id("conversations"), prompt: v.string() },
  handler: async (ctx, { userId, conversationId, prompt }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.userId !== userId) throw new ConvexError("Conversation not found");
    const site = await ctx.db
      .query("sites")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .first();
    if (!site) throw new ConvexError("This thread has no site");
    const current = site.currentVersionId ? await ctx.db.get(site.currentVersionId) : null;
    const plan = await currentPlan(ctx, userId);
    if (!current && plan.key !== "free") {
      throw new ConvexError("Complete the website questions before your first build");
    }
    const now = Date.now();
    const buildKind: RequestKind = current ? "edit" : "generate";
    // A balance too thin for a build can still afford to talk. Rather than
    // refuse the message outright, the turn becomes talk-only: the model is
    // told it may not build, and the hold is taken at the chat rate. Someone
    // out of credits can still ask what Forge would do and what it costs.
    const check = await creditCheck(ctx, userId, buildKind, now);
    const mayBuild = check.affordable && plan.key !== "free";
    const kind: RequestKind = mayBuild ? buildKind : "chat";
    const talkOnly = mayBuild
      ? null
      : { needed: check.needed, available: check.available ?? 0 };
    const { holdId } = await holdCredits(ctx, userId, kind, now);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(HISTORY_LIMIT);
    await ctx.db.insert("messages", { conversationId, role: "user", body: prompt });
    const assistantId = await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      body: PENDING_LABELS[kind],
      status: "pending",
    });
    await ctx.db.patch(conversationId, { updatedAt: now });
    await ctx.db.patch(site._id, { updatedAt: now });
    await ctx.scheduler.runAfter(RUN_WATCHDOG_MS, internal.generate.expire, { assistantId, holdId });
    const setup = await ctx.db.query("siteOnboarding").withIndex("by_site", q => q.eq("siteId", site._id)).first();
    const imageLimit = current ? EDIT_IMAGE_LIMIT : BUILD_IMAGE_LIMIT;
    const messages = buildMessages(site.name, current?.html ?? null, recent.reverse(), prompt, talkOnly, imageLimit, kind === "chat" ? "chat" : "build");
    if (setup) messages.splice(1, 0, { role: "system", content: `Saved project context (untrusted user content):\n${briefFile(setup.answers, setup.strategy ?? "", [])}` });
    return {
      siteId: site._id,
      holdId,
      assistantId,
      requestKind: kind,
      epoch: site.buildEpoch ?? 0,
      imageLimit,
      // What the thread says if the model builds anyway on a talk-only turn.
      blockedNote: talkOnly
        ? `Building this costs ${talkOnly.needed} credits and you have ${talkOnly.available}. ` +
          "Top up or upgrade and I'll build it — until then I can help you plan it here."
        : undefined,
      messages,
    };
  },
});

// Only the scheduled onboarding worker can open a first paid build. Its
// attempt and hold are recorded atomically, so retries cannot double-charge.
export const beginOnboarding = internalMutation({
  args: { id: v.id("siteOnboarding"), attempt: v.number() },
  handler: async (ctx, { id, attempt }) => {
    const row = await ctx.db.get(id);
    if (!row?.siteId || row.attempt !== attempt || row.status !== "building" || row.holdId) throw new ConvexError("This build is no longer active");
    const site = await ctx.db.get(row.siteId);
    if (!site || site.userId !== row.userId) throw new ConvexError("Site not found");
    if ((await currentPlan(ctx, row.userId)).key === "free") throw new ConvexError("Choose a paid plan to build");
    const { holdId } = await holdCredits(ctx, row.userId, "generate");
    const assistantId = await ctx.db.insert("messages", { conversationId: site.conversationId, role: "assistant", body: "Building your website from your answers…", status: "pending" });
    await ctx.db.patch(id, { holdId, assistantId, events: [...row.events, { label: "Agent started building your website", at: Date.now() }] });
    return {
      messages: buildMessages(site.name, null, [], "Build the website from the saved onboarding brief.", null, BUILD_IMAGE_LIMIT, "build"),
      result: { siteId: site._id, holdId, assistantId, requestKind: "generate" as const, epoch: site.buildEpoch ?? 0 },
    };
  },
});

export const finish = internalMutation({
  args: {
    assistantId: v.id("messages"),
    siteId: v.id("sites"),
    holdId: v.id("creditHolds"),
    requestKind,
    // Absent when the model answered instead of building.
    html: v.optional(v.string()),
    summary: v.string(),
    // Set when the turn was talk-only because a build was out of reach.
    blockedNote: v.optional(v.string()),
    onboardingId: v.optional(v.id("siteOnboarding")),
    attempt: v.optional(v.number()),
    epoch: v.optional(v.number()),
  },
  handler: async (ctx, { assistantId, siteId, holdId, requestKind: kind, html, summary, blockedNote, onboardingId, attempt, epoch }) => {
    const now = Date.now();
    const site = await ctx.db.get(siteId);
    if (epoch !== undefined && (site?.buildEpoch ?? 0) !== epoch) {
      if (await ctx.db.get(assistantId)) await ctx.db.delete(assistantId);
      await releaseHold(ctx, holdId);
      return "cancelled" as const;
    }
    const setup = onboardingId ? await ctx.db.get(onboardingId) : null;
    if (onboardingId && (!setup || setup.attempt !== attempt || setup.status !== "saving")) {
      await releaseHold(ctx, holdId);
      return "cancelled" as const;
    }
    // Nothing to store: either no page came back, or the turn was held at the
    // chat rate because a build was unaffordable, in which case a page that
    // came back anyway is dropped rather than handed over for a credit. Either
    // way the site keeps the version it had and the hold settles as a chat.
    if (html === undefined || kind === "chat") {
      const body = html === undefined ? summary : (blockedNote ?? summary);
      if (await ctx.db.get(assistantId)) {
        await ctx.db.patch(assistantId, { body, status: undefined });
      }
      await settleHold(ctx, holdId, REQUEST_COSTS.chat, now, "chat");
      return "ok" as const;
    }
    // The site was deleted while the build ran: nothing to attach it to, and
    // the user is not charged for a page they can never see.
    if (!site) {
      await releaseHold(ctx, holdId, now);
      return "cancelled" as const;
    }
    const versionId = await ctx.db.insert("siteVersions", {
      userId: site.userId,
      siteId,
      html,
      summary,
      requestKind: kind,
      createdAt: now,
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId, updatedAt: now });
    // The finished build goes onto the site's Forge address in the same
    // transaction that saves it, so a built site is never without a link and
    // the address never serves anything but the latest build. A claim that
    // fails must not cost the member the build they just paid for.
    let live: Awaited<ReturnType<typeof publishBuild>> = null;
    try {
      live = await publishBuild(ctx, site, versionId, now);
    } catch (error) {
      console.error("Forge could not publish the build:", describe(error));
    }
    if (setup) await ctx.db.patch(setup._id, { status: "complete", updatedAt: now,
      events: [...setup.events, { label: "Website saved and ready", at: now }] });
    if (await ctx.db.get(assistantId)) {
      const said = (summary || (kind === "generate" ? "Here's a first version of your site." : "Updated your site.")).trim();
      // A first build says where it went; every later one is already there.
      const address = kind === "generate" ? live?.url?.replace(/^https?:\/\//, "") : undefined;
      await ctx.db.patch(assistantId, {
        body: address ? `${/[.!?…]$/.test(said) ? said : `${said}.`} It's published at ${address}.` : said,
        status: undefined,
        versionId,
      });
    }
    await settleHold(ctx, holdId, undefined, now);
    return "ok" as const;
  },
});

export const fail = internalMutation({
  args: { assistantId: v.id("messages"), holdId: v.id("creditHolds"), reason: v.string() },
  handler: async (ctx, { assistantId, holdId, reason }) => {
    if (await ctx.db.get(assistantId)) {
      await ctx.db.patch(assistantId, { body: reason, status: "failed" });
    }
    await releaseHold(ctx, holdId);
  },
});

// The watchdog for a thread build. A turn that finished, failed or was
// cancelled has nothing left for it to do: the hold is no longer held and the
// reply is no longer pending, and both checks are what make it safe to fire.
export const expire = internalMutation({
  args: { assistantId: v.id("messages"), holdId: v.id("creditHolds") },
  returns: v.null(),
  handler: async (ctx, { assistantId, holdId }) => {
    const reason = "The build stopped responding. Try again.";
    const message = await ctx.db.get(assistantId);
    if (message?.status === "pending") {
      await ctx.db.patch(assistantId, { body: reason, status: "failed" });
      const run = await ctx.db
        .query("buildRuns")
        .withIndex("by_message", (q) => q.eq("messageId", assistantId))
        .first();
      if (run) await closeRun(ctx, { runId: run._id, status: "failed", error: reason });
    }
    await releaseHold(ctx, holdId);
    return null;
  },
});

function buildMessages(
  siteName: string,
  currentHtml: string | null,
  history: Doc<"messages">[],
  prompt: string,
  // Set when the balance cannot cover a build, which makes this turn TALK.
  talkOnly: { needed: number; available: number } | null,
  imageLimit: number,
  purpose: "chat" | "build",
): ChatMessage[] {
  const messages: ChatMessage[] = [
    // forge.md + frontend-design skill — every chat, build and strategy turn.
    { role: "system", content: FORGE_MD },
    { role: "system", content: FRONTEND_DESIGN },
    { role: "system", content: systemPrompt(imageLimit, purpose) },
  ];
  if (currentHtml) {
    messages.push({
      role: "system",
      content: `The site "${siteName}" currently looks like this. Apply the user's next request to it and return the whole updated file.\n\n\`\`\`html\n${currentHtml}\n\`\`\``,
    });
  }
  if (talkOnly) {
    messages.push({
      role: "system",
      content:
        `This turn is TALK, whatever the user asked for. Building would cost ${talkOnly.needed} credits and they have ${talkOnly.available}, ` +
        "so you must not return HTML or open a code block. Answer them and help them plan the site. " +
        "If they asked for something built or changed, say plainly what it would cost, what they have, " +
        "and that topping up or upgrading is what unlocks it — then keep helping them plan.",
    });
  }
  for (const message of history) {
    if (message.role === "system" || message.status || !message.body.trim()) continue;
    messages.push({ role: message.role, content: message.body });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

type Route = ReturnType<typeof chatRoute>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One chat completion. A provider that stumbles -- a dropped connection, a
// rate limit, a 5xx -- is asked once more before the build is called failed,
// and one whose output cap is lower than what was asked for says what its cap
// is, so the same request goes again inside it. A call that ran out its clock
// is not repeated: a second slow answer would only spend the build's time.
async function complete(
  route: Route,
  messages: ChatMessage[],
  maxTokens: number,
  deadline: number,
  trace?: ProviderTrace,
  meta?: { continuation?: number },
) {
  let limit = maxTokens;
  let host = route.baseUrl;
  try { host = new URL(route.baseUrl).host; } catch { /* keep the raw base if it is not a URL */ }
  for (let attempt = 0; attempt < MAX_COMPLETE_LOOPS; attempt += 1) {
    const timeout = Math.max(1000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()));
    const started = Date.now();
    await trace?.note({
      phase: "provider_request",
      label: meta?.continuation
        ? "Continuing a cut-off page"
        : attempt === 0
          ? "Calling the model"
          : "Retrying the model",
      level: attempt === 0 ? "info" : "warn",
      status: "calling",
      detail: {
        attempt,
        continuation: meta?.continuation,
        tokensAsked: limit,
        host,
        model: route.model,
      },
    });
    let response: Response;
    let bodyText: string;
    // The clock covers the whole exchange, the reply's body included. It is a
    // plain controller and timer because those are what every runtime has.
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(), timeout);
    try {
      response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        signal: clock.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({ model: route.model, messages, temperature: 0.7, max_tokens: limit }),
      });
      bodyText = await response.text();
    } catch (error) {
      const timedOut =
        clock.signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
      await trace?.note({
        phase: "provider_error",
        label: timedOut ? "The model took too long to answer" : "The model provider could not be reached",
        level: "error",
        detail: { attempt, continuation: meta?.continuation, durationMs: Date.now() - started, timedOut, host, model: route.model, errorClass: timedOut ? "timeout" : "unreachable" },
      });
      if (timedOut) throw new Error("The model took too long to answer. Try again.");
      if (attempt === 0) { await wait(RETRY_WAIT_MS); continue; }
      throw new Error("The model provider could not be reached. Try again in a moment.");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // A provider whose output cap is lower than what was asked for says so
      // in its own words. DeepSeek names the range, and that exact number is
      // used when it is there; anything else that refuses over the length just
      // gets one more go inside a cap every chat model clears, rather than
      // failing a build over a number.
      const named = response.status === 400 ? bodyText.match(/max_tokens[^[\]]*\[\s*\d+\s*,\s*(\d+)\s*\]/i) : null;
      const overLength =
        response.status === 400 && /max_?(?:output_?)?tokens/i.test(bodyText) && limit > SAFE_MAX_TOKENS;
      if ((named && Number(named[1]) > 0 && Number(named[1]) < limit) || overLength) {
        limit = named ? Number(named[1]) : SAFE_MAX_TOKENS;
        await trace?.note({
          phase: "provider_cap",
          label: "Lowered the model's length limit",
          level: "warn",
          detail: { httpStatus: 400, attempt, tokensAsked: limit, durationMs: Date.now() - started, host, model: route.model },
        });
        continue;
      }
      if (attempt === 0 && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        await trace?.note({
          phase: "provider_retry",
          label: "Retrying the model",
          level: "warn",
          detail: { httpStatus: response.status, attempt, durationMs: Date.now() - started, host, model: route.model, errorClass: "provider_http" },
        });
        await wait(RETRY_WAIT_MS);
        continue;
      }
      await trace?.note({
        phase: "provider_error",
        label: `The model provider answered ${response.status}`,
        level: "error",
        detail: { httpStatus: response.status, attempt, durationMs: Date.now() - started, host, model: route.model, errorClass: "provider_http" },
      });
      throw new Error(`The model provider answered ${response.status}${excerpt(bodyText)}`);
    }
    let data: { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] };
    try {
      data = JSON.parse(bodyText);
    } catch {
      await trace?.note({
        phase: "provider_error",
        label: "The model provider sent an unreadable reply",
        level: "error",
        detail: { httpStatus: response.status, attempt, durationMs: Date.now() - started, errorClass: "unreadable" },
      });
      throw new Error("The model provider sent an unreadable reply");
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      await trace?.note({
        phase: "provider_error",
        label: "The model returned an empty reply",
        level: "error",
        detail: { httpStatus: 200, attempt, durationMs: Date.now() - started, errorClass: "empty" },
      });
      throw new Error("The model returned an empty reply");
    }
    await trace?.note({
      phase: "provider_response",
      label: "The model answered",
      detail: {
        httpStatus: 200,
        durationMs: Date.now() - started,
        attempt,
        continuation: meta?.continuation,
        truncated: choice?.finish_reason === "length",
        replyChars: content.length,
        tokensAsked: limit,
        host,
        model: route.model,
      },
    });
    return { content, truncated: choice?.finish_reason === "length" };
  }
  throw new Error("The model provider kept refusing this request.");
}

// The chat route, and only the chat route: the deployment names the base URL,
// the key and the model, and nothing about them reaches a client. A page cut
// off by the output cap is picked up where it stopped rather than thrown away,
// which is the difference between a long site and a failed one.
export async function callProvider(
  messages: ChatMessage[],
  tokenLimit?: number,
  budgetMs = TEXT_BUDGET_MS,
  trace?: ProviderTrace,
  purpose: "chat" | "build" = "chat",
) {
  const route = chatRoute(purpose);
  if (!route.apiKey) {
    await trace?.note({
      phase: "provider_error",
      label: "Site generation isn't set up on this deployment yet",
      level: "error",
      detail: { keySet: false, errorClass: "unset" },
    });
    throw new ConvexError("Site generation isn't set up on this deployment yet");
  }
  const maxTokens =
    tokenLimit ??
    (Number(process.env.AI_MAX_TOKENS) || (purpose === "build" ? BUILD_MAX_TOKENS : DEFAULT_MAX_TOKENS));
  const deadline = Date.now() + Math.min(budgetMs, TEXT_BUDGET_MS);
  let reply = await complete(route, messages, maxTokens, deadline, trace);
  let content = reply.content;
  for (
    let round = 0;
    reply.truncated && round < MAX_CONTINUATIONS && /```html|<!doctype html/i.test(content) && deadline - Date.now() > CONTINUE_FLOOR_MS;
    round += 1
  ) {
    reply = await complete(
      route,
      [
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content:
            "Your reply was cut off by the length limit. Continue from the exact character where it stopped. " +
            "Do not repeat anything already written, do not restart the document, and do not add commentary or open a new code fence. " +
            "Output only the remaining text, and finish by closing the HTML document and then the code fence.",
        },
      ],
      maxTokens,
      deadline,
      trace,
      { continuation: round + 1 },
    );
    // A continuation that opens its own fence anyway would split the page in two.
    content += reply.content.replace(/^\s*```(?:html)?[ \t]*\r?\n/i, "");
  }
  return content;
}

// The page is the fenced block; the sentence before it is the summary. A
// reply that is nothing but a document still counts. A reply that never
// reaches for a page at all is an answer rather than a build, and comes back
// with `html: null` so the caller charges for a conversation instead.
export function parseReply(content: string) {
  const fence =
    content.match(/```html\s*\n?([\s\S]*?)```/i) ?? content.match(/```\s*\n?(<!doctype[\s\S]*?)```/i);
  // A reply that opens a page holds to the whole-page rule, so a document cut
  // off by the token cap fails loudly instead of landing in the thread as
  // prose. The tests are for a document being started -- an opening fence, or
  // a reply that begins as markup -- not for a tag named in passing, since a
  // web designer talking shop will mention <html> without building anything.
  const reachesForPage =
    Boolean(fence) ||
    /```html/i.test(content) ||
    /<!doctype html/i.test(content) ||
    /^\s*<html[\s>]/i.test(content);
  if (!reachesForPage) {
    const talk = content.trim().slice(0, TALK_LIMIT);
    if (!talk) throw new Error("The model returned an empty reply");
    return { html: null, summary: talk };
  }
  // A page that finished its document but never closed its fence is still a
  // whole page: the document's own end is what says so, not the backticks.
  const unfenced = fence ? null : content.match(/```html\s*\n?([\s\S]*<\/html>)\s*$/i);
  const html = fence
    ? fence[1].trim()
    : unfenced
      ? unfenced[1].trim()
      : /^\s*(<!doctype html|<html)/i.test(content)
        ? content.trim()
        : null;
  if (!html || !/<html[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) {
    throw new Error("The model did not return a complete page");
  }
  const opened = fence?.index ?? unfenced?.index;
  const before = opened === undefined ? "" : content.slice(0, opened).trim();
  const summary = (before.split(/\n+/).find((line) => line.trim()) ?? "")
    .replace(/^[\s\-*#>\d.)]+/, "")
    .trim()
    .slice(0, REASON_LIMIT);
  return { html, summary };
}

// What the provider said, as one line. An OpenAI-style error body is read for
// its message -- "Model Not Exist" says more on a screen than the JSON around
// it -- and anything else is quoted as it came.
function excerpt(text: string) {
  let line = text;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.trim()) line = message;
  } catch { /* Not JSON: the body is the excerpt. */ }
  line = line.replace(/\s+/g, " ").trim().slice(0, 160);
  return line ? `: ${line}` : "";
}

// What the user is told. Never a key, never more than a line.
export function describe(error: unknown) {
  const raw =
    error instanceof ConvexError
      ? String(error.data)
      : error instanceof Error
        ? error.message
        : String(error);
  const scrubbed = [process.env.AI_API_KEY, process.env.AI_IMAGE_API_KEY].reduce<string>(
    (text, key) => (key ? text.split(key).join("[key]") : text),
    raw,
  );
  return scrubbed.slice(0, REASON_LIMIT) || "The build failed";
}
