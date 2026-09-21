import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { creditCheck, currentPlan, holdCredits, releaseHold, settleHold } from "./billing";
import { providerTrace, type ProviderTrace } from "./diagnostics";
import { fulfilImages, IMAGE_MODEL_LABEL, imageRoute, wantsImages } from "./images";
import { briefFile } from "./onboardingQuestions";
import { FORGE_MD } from "./forgeMd";
import { FRONTEND_DESIGN } from "./frontendDesign";
import { REQUEST_COSTS, requestKind, type RequestKind } from "./plans";
import { publishBuild } from "./sites";

// How much of the thread the model sees, and how long a page it may write.
const HISTORY_LIMIT = 32;
const DEFAULT_MAX_TOKENS = 16000;
const REASON_LIMIT = 300;
// A conversational reply is the message itself, so it gets far more room than
// the one-line summary that rides along with a build.
const TALK_LIMIT = 4000;

// Conversation and site building run on DeepSeek Flash, and on nothing else.
// The deployment's `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY` name the route;
// what they fall back to is DeepSeek too, so an unset variable can never send
// a build somewhere else. Pictures have a route of their own in `images.ts`.
const CHAT_BASE_URL = "https://api.deepseek.com/v1";
const CHAT_MODEL = "deepseek-flash";
const CHAT_MODEL_LABEL = "DeepSeek V4.1 Flash";

// How many new pictures one reply may ask for.
export const BUILD_IMAGE_LIMIT = 4;
const EDIT_IMAGE_LIMIT = 2;

// One call may run long -- a whole site is a lot of tokens -- but a build as a
// whole has to finish inside an action's ten minutes with room for pictures.
const CALL_TIMEOUT_MS = 240000;
const TEXT_BUDGET_MS = 400000;
const CONTINUE_FLOOR_MS = 45000;
const MAX_CONTINUATIONS = 2;
const MAX_COMPLETE_LOOPS = 5;
const RETRY_WAIT_MS = 1500;

export function chatRoute() {
  const baseUrl = (process.env.AI_BASE_URL?.trim() || CHAT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim() || CHAT_MODEL;
  return {
    baseUrl,
    model,
    apiKey: process.env.AI_API_KEY,
    // What the agent says it runs on. It only says DeepSeek when it does.
    label: process.env.AI_MODEL_LABEL?.trim() || (/deepseek/i.test(model) ? CHAT_MODEL_LABEL : model),
    // Text never goes to the image provider. A chat route pointed at Gemini is
    // the image key in the wrong variable, and it is refused rather than used:
    // a site quietly built by the wrong model is worse than one that says why
    // it was not built.
    misrouted:
      /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(baseUrl) ||
      /gemini|imagen|banana|-image(?:-|$)/i.test(model),
  };
}

// Which model each kind of work goes to, for whoever runs the deployment:
// `npx convex run generate:routing`. Names and hosts only, never a key.
export const routing = internalQuery({
  args: {},
  handler: async () => {
    const chat = chatRoute();
    const image = imageRoute();
    return {
      chat: { host: new URL(chat.baseUrl).host, model: chat.model, label: chat.label, keySet: Boolean(chat.apiKey), misrouted: chat.misrouted },
      image: { host: new URL(image.baseUrl).host, model: image.model, label: IMAGE_MODEL_LABEL, keySet: Boolean(image.apiKey), pinnedToLite: image.pinned },
    };
  },
});

function systemPrompt(imageLimit: number) {
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
- Structure it as a real site, not a poster: a header with the name and a nav that links to every section; a hero that says what this is, who it is for and the one action to take; then the sections this business needs — what it offers, why it is different, how it works or what to expect, about, and a closing call to action with whatever contact details were supplied; then a footer. Every nav link points at a section id that exists.
- The main action a visitor should take appears in the hero, again after the offer, and in the closing section, always in the same words.
- Design with intent: one palette built from their brand or the feel they asked for, with accessible contrast; a clear type scale with at most two Google Fonts families; generous whitespace; one radius and spacing rhythm; layouts that change from section to section rather than one card grid repeated.
- Mobile-first and responsive from 320px to a wide desktop, with CSS grid and flexbox, fluid type through clamp(), and a nav that stays usable on a phone without JavaScript — let it wrap or scroll sideways, never hide it behind a script.
- Semantic landmarks (header, nav, main, section, footer), one h1, headings in order, alt text on every image, visible :focus-visible styles, and a prefers-reduced-motion rule if anything moves.
- Real, specific copy written for this business from what they told you — never lorem ipsum or "[placeholder]". Leave out testimonials, prices, statistics, awards, addresses, phone numbers and team members unless they were supplied.
- No scripts and no frameworks. Forms are static markup; do not imply that bookings, payments, accounts or form delivery work.
- Links between sections use anchors. Google Fonts are the only external stylesheet; use at most two families.

${pictures}

Reply with one sentence saying what you built or changed, then the complete HTML in a single \`\`\`html code block, and nothing after it. When the user asks for a change, apply it to the current file and return the whole updated file, keeping everything they did not ask to change.

TALK — when they ask a question, want an opinion, or are still working out what they want.
Reply in plain prose: short, concrete, and about their site. Do not return HTML, and do not open a code block of any kind. Say what you would do and offer to make the change, rather than making it. A build costs the user credits and a reply like this barely does, so do not rebuild the page to answer a question.

IDENTITY — if someone asks which AI or model you are, say it plainly in one sentence and get back to their site: your conversation and site building run on ${chatRoute().label}, and the pictures on a site are made by ${IMAGE_MODEL_LABEL}. You yourself are not Gemini, GPT or Claude, and you do not guess at anything about the models beyond this.

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
      const route = chatRoute();
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
        misrouted: route.misrouted,
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
          misrouted: route.misrouted,
        },
      });
      const reply = await callProvider(job.messages, undefined, undefined, trace);
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
    const setup = await ctx.db.query("siteOnboarding").withIndex("by_site", q => q.eq("siteId", site._id)).first();
    const imageLimit = current ? EDIT_IMAGE_LIMIT : BUILD_IMAGE_LIMIT;
    const messages = buildMessages(site.name, current?.html ?? null, recent.reverse(), prompt, talkOnly, imageLimit);
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
      messages: buildMessages(site.name, null, [], "Build the website from the saved onboarding brief.", null, BUILD_IMAGE_LIMIT),
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

function buildMessages(
  siteName: string,
  currentHtml: string | null,
  history: Doc<"messages">[],
  prompt: string,
  // Set when the balance cannot cover a build, which makes this turn TALK.
  talkOnly: { needed: number; available: number } | null,
  imageLimit: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    // forge.md + frontend-design skill — every DeepSeek chat/build turn.
    { role: "system", content: FORGE_MD },
    { role: "system", content: FRONTEND_DESIGN },
    { role: "system", content: systemPrompt(imageLimit) },
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
    try {
      response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(timeout),
        headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({ model: route.model, messages, temperature: 0.7, max_tokens: limit }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      await trace?.note({
        phase: "provider_error",
        label: timedOut ? "The model took too long to answer" : "The model provider could not be reached",
        level: "error",
        detail: { attempt, continuation: meta?.continuation, durationMs: Date.now() - started, timedOut, host, model: route.model, errorClass: timedOut ? "timeout" : "unreachable" },
      });
      if (timedOut) throw new Error("The model took too long to answer. Try again, or ask for a smaller change.");
      if (attempt === 0) { await wait(RETRY_WAIT_MS); continue; }
      throw new Error("The model provider could not be reached. Try again in a moment.");
    }
    const bodyText = await response.text();
    if (!response.ok) {
      const cap = response.status === 400 ? bodyText.match(/max_tokens[^[\]]*\[\s*\d+\s*,\s*(\d+)\s*\]/i) : null;
      if (cap && Number(cap[1]) > 0 && Number(cap[1]) < limit) {
        limit = Number(cap[1]);
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
) {
  const route = chatRoute();
  if (!route.apiKey) {
    await trace?.note({
      phase: "provider_error",
      label: "Site generation isn't set up on this deployment yet",
      level: "error",
      detail: { keySet: false, errorClass: "unset" },
    });
    throw new ConvexError("Site generation isn't set up on this deployment yet");
  }
  if (route.misrouted) {
    console.error(
      `Forge refused the chat route: AI_BASE_URL / AI_MODEL point at the image provider (${route.model}). ` +
        "Conversation and site building run on DeepSeek Flash; set AI_BASE_URL, AI_MODEL and AI_API_KEY for it.",
    );
    await trace?.note({
      phase: "provider_error",
      label: "Site generation isn't set up on this deployment yet",
      level: "error",
      detail: { keySet: Boolean(route.apiKey), misrouted: true, model: route.model, errorClass: "unset" },
    });
    throw new ConvexError("Site generation isn't set up on this deployment yet");
  }
  const maxTokens = tokenLimit ?? (Number(process.env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS);
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

function excerpt(text: string) {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 160);
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
