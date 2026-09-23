import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { creditCheck, currentPlan, holdCredits, releaseHold, settleHold } from "./billing";
import { closeRun, providerTrace, recordLastSign, type ProviderTrace } from "./diagnostics";
import { fulfilImages, IMAGE_MODEL_LABEL, imageRoute, wantsImages } from "./images";
import { briefFile } from "./onboardingQuestions";
import { reviewInFlight } from "./designCheck";
import { DESIGN_GOD } from "./designgod";
import { FED } from "./fed";
import { FORGE_MD } from "./forgeMd";
import { memoryEnabled, memoryNote } from "./memory";
import { hasPages, normalizePath, serializeSite, siteParts, withParts, type BuiltSite, type SitePage } from "./pages";
import { REQUEST_COSTS, requestKind, type RequestKind } from "./plans";
import { publishBuild } from "./sites";
import { assertDesignRules, gateInFlight, isSkillUI, NOT_EXTRACTED } from "./siteDesign";
import { isEventStream, readStream, StreamStopped, type Milestone, type StopReason, type StreamPhase, type StreamStats } from "./stream";

// How much of the thread the model sees, and how long a page it may write.
// A whole site — several pages behind one shell — is a great deal more output
// than a conversational reply, so a build is given its own ceiling. A
// provider whose own cap is lower says so, and `complete` retries inside it.
//
// A reasoning model bills its thinking inside that same ceiling: `max_tokens`
// caps the thinking and the answer together, so room that only fits the page
// leaves the page unwritten, which is the empty reply below. A one-page build
// on this deployment's model measured 15,592 tokens of thinking beside 11,344
// of page, and a site in pages is longer than that, so both ceilings hold the
// thinking as well as the answer. Neither is a spend: a reply that needs less
// costs less, and nothing is billed for room that goes unused.
const HISTORY_LIMIT = 32;
const DEFAULT_MAX_TOKENS = 32000;
const BUILD_MAX_TOKENS = 96000;
// Where a second go lands when the first came back as thinking and no answer,
// unless the provider has already named a cap below it.
const ROOM_TO_ANSWER = 64000;
// What to drop to when a provider refuses the length without naming its cap.
const SAFE_MAX_TOKENS = 8192;
const REASON_LIMIT = 300;
// A conversational reply is the message itself, so it gets far more room than
// the one-line summary that rides along with a build.
const TALK_LIMIT = 4000;

// A builder turn may attach SkillUI reference screenshots. Every other turn
// is still a string. DeepSeek reads the image parts as vision input.
export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: ChatContent };

export function textContent(content: ChatContent) {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

// Where conversation goes when the deployment says nothing. Chat reads
// `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY`. Planning and site building read
// `AI_BUILD_BASE_URL`, `AI_BUILD_MODEL` and `AI_BUILD_API_KEY` when those are
// set, and fall back to the chat route when they are not. Any provider that
// speaks the OpenAI chat shape serves either. These are only the fallbacks, so
// an unset chat variable lands on the model this deployment actually talks
// with rather than nowhere. Pictures have a route of their own in `images.ts`,
// and text never goes to it.
const CHAT_BASE_URL = "https://api.deepseek.com/v1";
const CHAT_MODEL = "deepseek-flash";
const CHAT_MODEL_LABEL = "DeepSeek v4.1 Flash";
const GEMINI_CHAT_HOST = "generativelanguage.googleapis.com";

export function isGeminiChatHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === GEMINI_CHAT_HOST;
  } catch {
    return false;
  }
}

// The thinking control. DeepSeek documents it for V4-Pro and V4.1-Flash as
// `reasoning_effort` beside `thinking: {type}`, with three levels -- low,
// high and max -- and thinking on by default at high. Gemini's own field
// takes low, medium and high, so the two vocabularies do not match and a
// level one route lacks is met with the nearest it has.
//
// Measured on this deployment's own key, one puzzle three times each:
//
//   thinking disabled         0        0        0   characters
//   reasoning_effort low    863      991    1,704
//   nothing sent          2,162    2,221    4,767   (the default, which is high)
//   reasoning_effort max  1,850    2,264    3,616
//
// Disabling it lands on exactly nothing three times, which is what proves the
// model reads these at all: an earlier pass here sent `enable_thinking`, a
// field this API does not have, watched it change nothing, and concluded the
// model ignored every control. It does not. Effort is a ceiling on how long
// it is willing to think rather than a quota it must spend, so max only pulls
// away from high on work hard enough to want it -- a whole website, not a
// puzzle about light switches.
//
// A provider nobody has measured still gets a plain body.
// DeepSeek takes seven names for three real efforts and maps them itself:
// minimal and low land on low; medium, high and xhigh on high; max and ultra
// on max. All seven are passed through as written, because the provider's own
// table is the mapping and `generate:routing` should report what was sent
// rather than something rewritten on the way. Gemini has its own three.
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
const GEMINI_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const DEEPSEEK_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_MODELS = new Set(["deepseek-flash", "deepseek-v4-pro"]);
// GLM 5.3 always reasons. It accepts low, high and max, and refuses thinking
// disabled. Planning asks for max. Designing and writing the site asks for
// high. https://docs.z.ai/guides/llm/glm-5.3
const GLM_MODEL = "glm-5.3";

export function reasoningEffort(
  baseUrl: string,
  model = "",
  purpose: Purpose = "chat",
): ReasoningEffort | undefined {
  const gemini = isGeminiChatHost(baseUrl);
  const glm = model === GLM_MODEL;
  // Planning asks for max. Designing and writing the site asks for high.
  // GLM only has those two plus low, and one env value cannot name both, so
  // this split does not read AI_REASONING_EFFORT.
  if (glm) return purpose === "strategy" ? "max" : "high";
  const takes = gemini ? GEMINI_EFFORTS : EFFORT_MODELS.has(model) ? DEEPSEEK_EFFORTS : null;
  if (!takes) return undefined;
  // Every turn asks for it, at the level the work is worth. Writing a site is
  // what the top of the range is for, and so is the brief that build is going
  // to follow -- a strategist that thought lightly hands a build a thin brief
  // and no amount of effort downstream gets it back. A reply and the memory
  // note sit at high, which is also what this provider does when asked for
  // nothing, said out loud so the request means it.
  const wanted = (process.env.AI_REASONING_EFFORT?.trim().toLowerCase() ?? "") as ReasoningEffort;
  if (takes.includes(wanted)) return wanted;
  // A name this route does not have. Gemini is the narrower vocabulary, so
  // anything above its ceiling meets its ceiling, and minimal meets low.
  if (wanted === "minimal") return "low";
  if (wanted === "xhigh" || wanted === "max" || wanted === "ultra") return "high";
  // Unset. Gemini keeps the high it has always had. On a route with a level
  // above high, a build takes it and everything else stays at high; setting
  // AI_REASONING_EFFORT overrides both, since that is the operator's word.
  if (gemini) return "high";
  return purpose === "chat" ? "high" : "max";
}

// The OpenAI-shaped body every chat and build call sends — `complete`, the
// probe, and anything else that shares this route, memory included. Pictures
// never go through here. `reasoning_effort` is present only for Gemini.
export function completionBody(
  route: { model: string; baseUrl?: string; purpose?: Purpose },
  messages: ChatMessage[],
  maxTokens: number,
) {
  const effort = reasoningEffort(route.baseUrl ?? "", route.model, route.purpose ?? "chat");
  // DeepSeek's thinking models document temperature, presence_penalty and
  // frequency_penalty as having no effect while thinking is on -- which it is
  // by default -- so the field is left off rather than sent to be ignored.
  // GLM 5.3's own sample sends temperature 1 beside thinking enabled.
  const thinks = EFFORT_MODELS.has(route.model);
  const glm = route.model === GLM_MODEL;
  return {
    model: route.model,
    messages,
    ...(thinks ? {} : { temperature: glm ? 1 : 0.7 }),
    max_tokens: maxTokens,
    ...(effort ? { reasoning_effort: effort } : {}),
    // Named beside the level, the way the provider's own example does.
    // GLM 5.3 refuses a request that disables thinking, so it is sent on.
    ...(effort && (thinks || glm) ? { thinking: { type: "enabled" } } : {}),
  };
}

// No call is cut off for taking long: a reply is read as it streams, and it is
// stopped only by what the stream shows (see `complete`). What is left of the
// clock is the platform's own -- an action has ten minutes -- and the words get
// all of it the pictures and the save do not need: up to a minute for the
// pictures, which are made side by side, and a few seconds to store the page.
const TEXT_BUDGET_MS = 480000;
const CONTINUE_FLOOR_MS = 45000;
// A second go at a whole site is another long call, so one is only started
// while there is real time left to finish it in.
const ANSWER_FLOOR_MS = 90000;
const MAX_CONTINUATIONS = 2;
const MAX_COMPLETE_LOOPS = 5;
const RETRY_WAIT_MS = 1500;
// A thread build that the platform stops -- past ten minutes, out of memory --
// never reaches its own catch, so this is what gives its credits back and
// tells the thread. It sits past the action's limit so it can only ever speak
// for a build that is already gone.
const RUN_WATCHDOG_MS = 610000;

// The route a turn takes. A conversational reply stays on the chat provider.
// Planning (the strategy brief) and writing the site share one route, so a
// deployment may point both at another provider with `AI_BUILD_BASE_URL`,
// `AI_BUILD_API_KEY` and `AI_BUILD_MODEL`. Any of those left unset falls back
// to the chat route, so a deployment that has not chosen still plans and
// builds on the model chat uses.
// The kinds of turn this route carries. They differ in what they are worth
// thinking about and, for planning, a build and its design review, which
// provider answers. The design auditors are separate agents with their own
// instructions, but they ride the build route: they judge the build's work, so
// they answer on the model the deployment chose for building.
export type Purpose = "chat" | "build" | "strategy" | "review";

function agentTurn(purpose: Purpose) {
  return purpose === "build" || purpose === "strategy" || purpose === "review";
}

export function chatRoute(purpose: Purpose = "chat") {
  const agent = agentTurn(purpose);
  const baseUrl = (
    (agent ? process.env.AI_BUILD_BASE_URL?.trim() : "") ||
    process.env.AI_BASE_URL?.trim() ||
    CHAT_BASE_URL
  ).replace(/\/+$/, "");
  const model =
    (agent ? process.env.AI_BUILD_MODEL?.trim() : "") ||
    process.env.AI_MODEL?.trim() ||
    CHAT_MODEL;
  const chatModel = process.env.AI_MODEL?.trim() || CHAT_MODEL;
  return {
    baseUrl,
    model,
    purpose,
    apiKey: (agent ? process.env.AI_BUILD_API_KEY?.trim() : "") || process.env.AI_API_KEY,
    // What the agent says it runs on. The marketing name belongs to the chat
    // model. Planning and building on another id report that id, so a build
    // never introduces itself as the model that only answers chat.
    label:
      agent && model !== chatModel
        ? model
        : process.env.AI_MODEL_LABEL?.trim() || (model === CHAT_MODEL ? CHAT_MODEL_LABEL : model),
  };
}

// The ceiling one reply is given, thinking included. `AI_MAX_TOKENS` is the
// deployment's own cap and wins where it is set; unset, a build gets room for
// a whole site and a conversation gets room for an answer.
export function maxTokensFor(purpose: Purpose) {
  return Number(process.env.AI_MAX_TOKENS) || (purpose === "build" ? BUILD_MAX_TOKENS : DEFAULT_MAX_TOKENS);
}

// Which model each kind of work goes to, for whoever runs the deployment:
// `npx convex run generate:routing`. Names and hosts only, never a key.
export const routing = internalQuery({
  args: {},
  handler: async () => {
    const chat = chatRoute();
    const build = chatRoute("build");
    const strategy = chatRoute("strategy");
    const review = chatRoute("review");
    const image = imageRoute();
    return {
      chat: { host: new URL(chat.baseUrl).host, model: chat.model, label: chat.label, keySet: Boolean(chat.apiKey), reasoningEffort: reasoningEffort(chat.baseUrl, chat.model, "chat") ?? null, maxTokens: maxTokensFor("chat") },
      build: { host: new URL(build.baseUrl).host, model: build.model, label: build.label, keySet: Boolean(build.apiKey), sameAsChat: build.model === chat.model && build.baseUrl === chat.baseUrl, reasoningEffort: reasoningEffort(build.baseUrl, build.model, "build") ?? null, maxTokens: maxTokensFor("build") },
      strategy: { host: new URL(strategy.baseUrl).host, model: strategy.model, label: strategy.label, sameAsBuild: strategy.model === build.model && strategy.baseUrl === build.baseUrl, reasoningEffort: reasoningEffort(strategy.baseUrl, strategy.model, "strategy") ?? null },
      // The design auditors (crew.ts) ride this route on every build and edit.
      review: { host: new URL(review.baseUrl).host, model: review.model, on: true, sameAsBuild: review.model === build.model && review.baseUrl === build.baseUrl, reasoningEffort: reasoningEffort(review.baseUrl, review.model, "review") ?? null, maxTokens: maxTokensFor("review") },
      image: { host: new URL(image.baseUrl).host, model: image.model, label: IMAGE_MODEL_LABEL, keySet: Boolean(image.apiKey), pinnedToLite: image.pinned },
    };
  },
});

// The platform contract, and nothing else. Every line here is a fact about
// what this deployment can store, serve or parse -- `parseReply` wants a shell
// and its pages in fenced blocks, `siteVersions` holds them, a published page
// runs its scripts and loads from any host, and `images.ts` reads the
// forge-image markers. How a page looks is not decided here: that belongs to
// FORGE_MD and the design files it carries, so nothing in this file can
// outrank them.
// What a build turn actually carries, for whoever runs the deployment:
// `npx convex run generate:promptCheck`. `routing` says where a turn is sent
// and `probe:chat` says what answers; this says what the agent was told. It
// reports each system message's size and opening line -- never the text, which
// would put the whole prompt in a terminal.
export const promptCheck = internalQuery({
  args: {},
  handler: async () => {
    const turn = buildMessages("Example Co", null, [], "Build the site.", null, "build", null);
    return turn
      .filter((message) => message.role === "system")
      .map((message) => ({
        chars: textContent(message.content).length,
        opens: textContent(message.content).split("\n").find((line) => line.trim())?.slice(0, 64) ?? "",
      }));
  },
});

function systemPrompt(purpose: "chat" | "build") {
  const pictures = imageRoute().apiKey
    ? `IMAGES — pictures are made for you by an image model after you reply.
- Ask for one with an img whose src is forge-image: followed by a number, describing the picture in data-forge-image, like this: <img src="forge-image:1" data-forge-image="Morning light across the counter of a small neighbourhood bakery, sourdough loaves in the foreground, warm and unposed, editorial photograph" data-forge-aspect="16:9" alt="Sourdough loaves on the counter" width="1600" height="900">
- data-forge-aspect is one of 1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16. No text, logos or watermarks inside a picture.
- Ask for every new picture the finished site needs. There is no per-build or per-edit image limit.
- An img whose src is already an https or data address is finished: keep its src exactly as it is and do not describe it again. Image addresses supplied in the saved brief may be used as they are. Never link to any other external image; everything else is CSS gradients, inline SVG and colour.`
    : `IMAGES — pictures cannot be made on this turn. Keep any img that already has an https or data address exactly as it is, use image addresses supplied in the saved brief as they are, never write forge-image, and never link to any other external image. Everything else is CSS gradients, inline SVG and colour.`;
  return `You are Forge, the website-building agent inside Forge Nexxus. People describe what they want in plain language and you hand back a finished website.

You give one of two kinds of reply, and what the user asked for decides which.

BUILD — when they describe a site to make, or ask for a change to it.
What this platform can serve, which is not a matter of taste:
- A site is one shell and one or more pages. The shell is a complete document — <!doctype html> … </html>, with a lang, a <title>, a meta description, a meta viewport, all CSS in one <style> block in the <head>, and whatever every page shares, like the nav and footer — holding the comment <!--forge-page--> exactly where a page's own markup goes. A page is only that markup, with no html, head or body of its own. Each page is served at its path with the shell around it.
- Every page has a path: the home page is / and the others are short lowercase paths like /about. A link between pages is its path; a link within a page is an in-page anchor. Link only to pages you return.
- JavaScript runs on a published site, and scripts, stylesheets, fonts and libraries may load from any host. Use any client-side behaviour or external service the site needs, including menus, galleries, filters, carts, checkout, payments, bookings, authentication and form submission.

${pictures}

Reply with one sentence saying what you built or changed, then the shell in a \`\`\`html shell block, then each page in its own \`\`\`html path="/about" title="About" block, and nothing after. A one-page site is a shell and one page at /. The shell must end with </html> inside its block or the build is rejected. When the user asks for a change, apply it to the current site and return the whole updated site, every block, keeping everything they did not ask to change. The saved SkillUI Ultra design reference is required for every build and edit. Match it, but never reuse its source copy, images, logos or brand identity. The Type, Icons, accessibility and Anti-slop rules in DESIGN_GOD win over it.

TALK — when they ask a question, want an opinion, or are still working out what they want.
Reply in plain prose: short, concrete, and about their site. Do not return HTML, and do not open a code block of any kind. Say what you would do and offer to make the change, rather than making it. A build costs the user credits and a reply like this barely does, so do not rebuild the page to answer a question.

IDENTITY — if someone asks which AI or model you are, say it plainly in one sentence and get back to their site: this turn runs on ${chatRoute(purpose).label}, and the pictures on a site are made by ${IMAGE_MODEL_LABEL}. Those two names are all you know: never guess at a model's family, version, maker or abilities beyond them, and never claim to be or not to be some other company's model.

ADDRESSES AND PLANS — never state or guess a site's address: where it is published depends on how this deployment's hosting is set up, and the app tells the member their real one when it publishes. The first address is assigned when the build finishes and the member never picks it, so never ask what they want it to be and never wait for one before building. A domain of their own is a plan entitlement that not every plan carries, so never tell a member they can connect one.

Never ask the user questions or append a follow-up question. For an ambiguous request, use the saved website brief and decide. Keep strategy private. If the request is clearly about creating or changing a website, build it.`;
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
      if (job.requestKind !== "chat") await trace.note({ phase: "design_loaded", label: "Using this site's saved design reference" });
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
      const site = builtSite(parsed);
      if (site && job.requestKind !== "chat") {
        const reference = await ctx.runQuery(internal.siteDesign.forSite, { siteId: job.siteId });
        if (!reference || reference.buildEpoch !== job.epoch || !isSkillUI(reference)) throw new Error(NOT_EXTRACTED);
        assertDesignRules(site, reference.referenceUrl);
        // A built site is saved only once the design auditors agree it
        // matches the reference (designGate.ts), which finishes the turn.
        await ctx.runMutation(internal.designGate.open, {
          source: "thread",
          runId,
          userId,
          siteId: job.siteId,
          assistantId: job.assistantId,
          holdId: job.holdId,
          requestKind: job.requestKind,
          epoch: job.epoch,
          siteName: job.siteName,
          prompt: text,
          remember: job.remember,
          blockedNote: job.blockedNote,
          ...site,
          summary: parsed.summary,
        });
        return { messageId: assistantId! };
      }
      const turn = {
        runId,
        userId,
        siteId: job.siteId,
        assistantId: job.assistantId,
        holdId: job.holdId,
        requestKind: job.requestKind,
        epoch: job.epoch,
        siteName: job.siteName,
        prompt: text,
        remember: job.remember,
        blockedNote: job.blockedNote,
        summary: parsed.summary,
        clones: parsed.clones,
      };
      await finishThreadBuild(ctx, trace, { ...turn, site });
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

// The end of a thread turn: the pictures a page asked for, the save, the log
// and the memory note. A build comes here from the design audit
// (`designGate.ts`) once its auditors agree, with the site they agreed to.
export async function finishThreadBuild(
  ctx: ActionCtx,
  trace: ProviderTrace,
  turn: {
    runId: Id<"buildRuns">;
    userId: Id<"users">;
    siteId: Id<"sites">;
    assistantId: Id<"messages">;
    holdId: Id<"creditHolds">;
    requestKind: RequestKind;
    epoch: number;
    siteName: string;
    prompt: string;
    remember: boolean;
    blockedNote?: string;
    site: BuiltSite | null;
    summary: string;
    clones?: string;
  },
) {
  // The pictures a page asked for are made before it is stored, so the
  // version that lands never points at anything that does not exist. A page
  // that came back on a talk-only turn is about to be dropped: it gets none.
  let imageWanted = 0;
  let imageMade = 0;
  let site = turn.site;
  if (site && turn.requestKind !== "chat") {
    const parts = siteParts(site);
    if (wantsImages(parts.join("\n"))) {
      await trace.note({ phase: "images", label: "Making pictures", status: "images" });
    }
    const pictures = await fulfilImages(ctx, { parts, userId: turn.userId, siteId: turn.siteId, epoch: turn.epoch });
    site = withParts(site, pictures.parts);
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
  const siteChars = site ? siteParts(site).join("").length : undefined;
  await trace.note({
    phase: "saving",
    label: turn.requestKind === "chat" ? "Saving the reply" : "Saving your website",
    status: "saving",
    detail: { htmlChars: siteChars, requestKind: turn.requestKind },
  });
  const finished = await ctx.runMutation(internal.generate.finish, {
    assistantId: turn.assistantId,
    siteId: turn.siteId,
    holdId: turn.holdId,
    requestKind: turn.requestKind,
    ...site,
    summary: turn.summary,
    blockedNote: turn.blockedNote,
    epoch: turn.epoch,
    clones: turn.clones,
  });
  if (finished === "cancelled") {
    await ctx.runMutation(internal.diagnostics.close, {
      runId: turn.runId,
      status: "failed",
      error: "Build cancelled",
    });
    return;
  }
  await ctx.runMutation(internal.diagnostics.close, {
    runId: turn.runId,
    status: "complete",
    htmlChars: siteChars,
    imageWanted,
    imageMade,
  });
  // What was said is reflected on after the reply has landed, on its own
  // clock: the page never goes along, and a hiccup here is not the turn's.
  if (turn.remember) {
    try {
      await ctx.scheduler.runAfter(0, internal.memory.reflect, {
        userId: turn.userId,
        siteName: turn.siteName,
        prompt: turn.prompt,
        reply: turn.summary,
      });
    } catch (error) {
      console.error("Forge could not queue the memory update:", describe(error));
    }
  }
}

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
    const design = mayBuild
      ? await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", site._id)).first()
      : null;
    if (mayBuild && (!design || design.buildEpoch !== (site.buildEpoch ?? 0) || !isSkillUI(design))) {
      throw new ConvexError(NOT_EXTRACTED);
    }
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
    const messages = buildMessages(site.name, current ?? null, recent.reverse(), prompt, talkOnly, kind === "chat" ? "chat" : "build", await memoryNote(ctx, userId));
    if (design) messages.splice(4, 0, { role: "system", content: design.prompt });
    if (setup) messages.splice(3, 0, { role: "system", content: `Saved project context:\n${briefFile(setup.answers, setup.strategy ?? "", [])}` });
    return {
      siteId: site._id,
      siteName: site.name,
      // What the current header, menu and footer are made of, so the turn can
      // tell whether a reply changed them and needs the design reviewer.
      chrome: null,
      // Whether this turn is reflected on once it is answered.
      remember: await memoryEnabled(ctx, userId),
      holdId,
      assistantId,
      requestKind: kind,
      epoch: site.buildEpoch ?? 0,
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
    const design = await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", site._id)).first();
    if (!design || design.buildEpoch !== (site.buildEpoch ?? 0) || !isSkillUI(design)) throw new ConvexError(NOT_EXTRACTED);
    if ((await currentPlan(ctx, row.userId)).key === "free") throw new ConvexError("Choose a paid plan to build");
    const { holdId } = await holdCredits(ctx, row.userId, "generate");
    const assistantId = await ctx.db.insert("messages", { conversationId: site.conversationId, role: "assistant", body: "Building your website from your answers…", status: "pending" });
    await ctx.db.patch(id, { holdId, assistantId, events: [...row.events, { label: "Agent started building your website", at: Date.now() }] });
    const memory = await memoryNote(ctx, row.userId);
    return {
      siteName: site.name,
      // Kept by a build written a page at a time, so every step says the same.
      memory,
      messages: onboardingMessages(site.name, memory),
      result: { siteId: site._id, holdId, assistantId, requestKind: "generate" as const, epoch: site.buildEpoch ?? 0 },
    };
  },
});

// What a first build is asked, ahead of the brief file itself.
const ONBOARDING_REQUEST = "Build the website from the saved onboarding brief.";

// The turn a first build is written from: the house rules, the design files,
// the platform contract and the member's memory note. A build written a page
// at a time (buildDraft.ts) sends it again on every step, so each step is told
// exactly what a one-reply build is.
export function onboardingMessages(siteName: string, memory: string | null) {
  return buildMessages(siteName, null, [], ONBOARDING_REQUEST, null, "build", memory);
}

export const finish = internalMutation({
  args: {
    assistantId: v.id("messages"),
    siteId: v.id("sites"),
    holdId: v.id("creditHolds"),
    requestKind,
    // Absent when the model answered instead of building. A build from before
    // pages existed is `html` alone; a build with pages is `shell` and `pages`.
    html: v.optional(v.string()),
    shell: v.optional(v.string()),
    pages: v.optional(v.array(v.object({ path: v.string(), title: v.string(), body: v.string() }))),
    summary: v.string(),
    // Set when the turn was talk-only because a build was out of reach.
    blockedNote: v.optional(v.string()),
    onboardingId: v.optional(v.id("siteOnboarding")),
    attempt: v.optional(v.number()),
    epoch: v.optional(v.number()),
    // The Awwwards originals the header, the dropdown menu and the footer were
    // cloned from, as the design agent named them.
    clones: v.optional(v.string()),
  },
  handler: async (ctx, { assistantId, siteId, holdId, requestKind: kind, html, shell, pages, summary, blockedNote, onboardingId, attempt, epoch, clones }) => {
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
    const built: BuiltSite = hasPages({ shell, pages }) ? { shell, pages } : { html };
    const nothingBuilt = siteParts(built).length === 0;
    if (nothingBuilt || kind === "chat") {
      const body = nothingBuilt ? summary : (blockedNote ?? summary);
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
    const design = await ctx.db.query("siteDesignPackages").withIndex("by_site", q => q.eq("siteId", siteId)).first();
    if (!design || design.buildEpoch !== (site.buildEpoch ?? 0)) {
      await releaseHold(ctx, holdId, now);
      return "cancelled" as const;
    }
    // A reply that did not name its originals again keeps the ones the site
    // already had, so the next edit is still told what it is keeping.
    const versionId = await ctx.db.insert("siteVersions", {
      userId: site.userId,
      siteId,
      ...built,
      summary,
      requestKind: kind,
      createdAt: now,
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId, updatedAt: now });
    // The finished build goes onto the site's Forge address in the same
    // transaction that saves it, so a built site is never without a link and
    // the address never serves anything but the latest build. A claim that
    // fails must not cost the member the build they just paid for.
    try {
      await publishBuild(ctx, site, versionId, now);
    } catch (error) {
      console.error("Forge could not publish the build:", describe(error));
    }
    if (setup) await ctx.db.patch(setup._id, { status: "complete", updatedAt: now,
      events: [...setup.events, { label: "Website saved and ready", at: now }] });
    if (await ctx.db.get(assistantId)) {
      const said = (summary || (kind === "generate" ? "Here's a first version of your site." : "Updated your site.")).trim();
      await ctx.db.patch(assistantId, {
        body: said,
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
      // A build the design audit is holding outlives this clock, because each
      // step of the audit is an action of its own. While the audit is moving
      // the watchdog waits for it; once it has gone quiet for longer than a
      // step can run, the watchdog speaks for it.
      const gate = await ctx.db
        .query("designGates")
        .withIndex("by_message", (q) => q.eq("assistantId", assistantId))
        .order("desc")
        .first();
      if (gateInFlight(gate)) {
        await ctx.scheduler.runAfter(RUN_WATCHDOG_MS, internal.generate.expire, { assistantId, holdId });
        return null;
      }
      if (gate?.status === "checking" || gate?.status === "reworking") {
        await ctx.db.patch(gate._id, { status: "failed", error: reason, html: undefined, shell: undefined, pages: undefined, updatedAt: Date.now() });
      }
      const review = await ctx.db
        .query("designReviews")
        .withIndex("by_message", (q) => q.eq("assistantId", assistantId))
        .order("desc")
        .first();
      if (reviewInFlight(review)) {
        await ctx.scheduler.runAfter(RUN_WATCHDOG_MS, internal.generate.expire, { assistantId, holdId });
        return null;
      }
      if (review?.status === "checking" || review?.status === "revising") {
        await ctx.db.patch(review._id, { status: "failed", error: reason, html: undefined, shell: undefined, pages: undefined, updatedAt: Date.now() });
      }
      // The turn that started a check has already answered the member, so a
      // check that went quiet has only the thread to say so in: its reply
      // stays visible rather than failing out of sight.
      await ctx.db.patch(assistantId, review ? { body: reason, status: undefined } : { body: reason, status: "failed" });
      const run = await ctx.db
        .query("buildRuns")
        .withIndex("by_message", (q) => q.eq("messageId", assistantId))
        .first();
      if (run) {
        await recordLastSign(ctx, run._id);
        await closeRun(ctx, { runId: run._id, status: "failed", error: reason });
      }
    }
    await releaseHold(ctx, holdId);
    return null;
  },
});

function buildMessages(
  siteName: string,
  current: (BuiltSite & { clones?: string }) | null,
  history: Doc<"messages">[],
  prompt: string,
  // Set when the balance cannot cover a build, which makes this turn TALK.
  talkOnly: { needed: number; available: number } | null,
  purpose: "chat" | "build",
  // What Forge remembers about this member, or null when memory is off or
  // empty. It rides every text turn and never an image.
  memory: string | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    // House rules, custom design, frontend-design skill — every chat, build and strategy turn.
    { role: "system", content: FORGE_MD },
    { role: "system", content: DESIGN_GOD },
    { role: "system", content: FED },
    { role: "system", content: systemPrompt(purpose) },
  ];
  if (memory) messages.push({ role: "system", content: memory });
  // The site as the model last wrote it, in the same blocks it is asked to
  // return, so an edit is a change to what is there and not a fresh build.
  const shown = current ? serializeSite(current) : null;
  if (shown) {
    messages.push({
      role: "system",
      content: `The site "${siteName}" currently looks like this. Apply the user's next request to it and return the whole updated site, every block, in the same form. Keep it matching its saved SkillUI Ultra design reference.\n\n${shown}`,
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

// The design agent's turn when its work is sent back: the same instructions a
// build reads, the SkillUI Ultra reference where a build reads it, the site as
// it stands, and the fixes as the request.
export function designAgentTurn(siteName: string, site: BuiltSite, clones: string | undefined, request: string, design?: string) {
  const messages = buildMessages(siteName, { ...site, clones }, [], request, null, "build", null);
  if (design) messages.splice(4, 0, { role: "system", content: design });
  return messages;
}

type Route = ReturnType<typeof chatRoute>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a model is told after it spent a whole ceiling thinking. The ceiling is
// the half of that Forge can change on its own; this is the half the model can.
const ANSWER_NOW =
  "Your last reply hit the length limit while you were still thinking, so it carried no answer at all. " +
  "Keep the planning short this time and write the reply itself, in full, in the format the rules above ask for.";

// One more instruction, in front of the request it is about, which is where
// the rest of this build puts them.
function withNudge(messages: ChatMessage[], nudge: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  const note = { role: "system" as const, content: nudge };
  return last ? [...messages.slice(0, -1), note, last] : [note];
}

// What a model is told after its last reply was stopped for going round in
// circles. The same request would buy the same loop; this one asks for less
// planning, which is the part of the reply that looped.
const GO_ROUND =
  "Your last reply went round in circles, repeating the same thinking, and was stopped. " +
  "Keep the planning short this time, decide, and write the reply itself, in full, in the format the rules above ask for.";

// Replies are streamed, because a stream is what lets a stall be seen for what
// it is -- the stream stopping, or repeating itself -- instead of guessed from
// the clock. A provider that cannot stream is the one reason to turn it off:
// `npx convex env set AI_STREAM 0`, and replies are read whole as before.
export function streamReplies() {
  return !/^(0|off|false|no)$/i.test(process.env.AI_STREAM?.trim() ?? "");
}

// The request `complete` sends: the shared body, asked for as a stream. The
// provider's own token counts ride the last chunk where it is known to send
// them; an unmeasured provider gets the plain streaming request.
function requestBody(route: Route, messages: ChatMessage[], limit: number, stream: boolean) {
  return {
    ...completionBody(route, messages, limit),
    ...(stream ? { stream: true } : {}),
    ...(stream && EFFORT_MODELS.has(route.model) ? { stream_options: { include_usage: true } } : {}),
  };
}

// A line from a provider or a connection, safe to keep: one line, and never a key.
function scrubKeys(text: string) {
  return [process.env.AI_API_KEY, process.env.AI_BUILD_API_KEY, process.env.AI_IMAGE_API_KEY]
    .reduce<string>((out, key) => (key ? out.split(key).join("[key]") : out), text)
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_CLASS: Record<StopReason, string> = {
  dropped: "stream_dropped",
  provider_error: "provider_stream_error",
  looping: "looping",
  out_of_time: "out_of_time",
};

function stopLabel(reason: StopReason, phase: StreamPhase) {
  if (reason === "looping") return "The model was repeating itself";
  if (reason === "provider_error") return "The provider stopped part way with an error";
  if (reason === "dropped") return "The connection to the model dropped";
  return phase === "writing"
    ? "The build ran out of time while the model was writing"
    : phase === "thinking"
      ? "The build ran out of time while the model was thinking"
      : "The build ran out of time before the model started";
}

// What the member is told when a reply stops, by where it had got to. None of
// these names a length of time, because none of them was decided by one.
function outOfTimeMessage(phase: StreamPhase) {
  return phase === "writing"
    ? "The model was still writing your website when the build ran out of time. Try again."
    : phase === "thinking"
      ? "The model was still thinking your website through when the build ran out of time. Try again."
      : "The model hadn't started on your website when the build ran out of time. Try again in a moment.";
}
// A reply the stream stopped: what the member reads, with where the reply had
// got to kept alongside for whatever carries the build on.
export class ReplyStopped extends Error {
  constructor(readonly stop: StreamStopped) {
    super(stoppedMessage(stop));
    this.name = "ReplyStopped";
  }
}

function stoppedMessage(stop: StreamStopped) {
  if (stop.reason === "looping") return "The model got stuck repeating itself instead of writing your website. Try again.";
  if (stop.reason === "provider_error") {
    const said = stop.stats.providerError?.replace(/[.!?]?\s*$/, "");
    return `The model provider stopped part way with an error${said ? `: ${said}` : ""}. Try again.`;
  }
  if (stop.reason === "out_of_time") return outOfTimeMessage(stop.stats.phase);
  return stop.stats.phase === "writing"
    ? "The connection to the model dropped while it was writing your website. Try again."
    : "The connection to the model dropped before it started writing your website. Try again.";
}

// The debugger's view of a streamed reply: where it had got to and what it had
// produced. `sinceTokenMs` is how long it had been quiet -- evidence, never a
// trigger.
function streamDetail(stats: StreamStats, started: number) {
  return {
    stream: true,
    streamPhase: stats.phase,
    reasoningChars: stats.reasoningChars || undefined,
    replyChars: stats.contentChars || undefined,
    chunks: stats.chunks,
    keepAlives: stats.keepAlives || undefined,
    bytes: stats.bytes,
    firstTokenMs: stats.firstTokenMs,
    firstContentMs: stats.firstContentMs,
    sinceTokenMs: stats.lastTokenAt !== undefined ? Date.now() - stats.lastTokenAt : undefined,
    finishReason: stats.finishReason,
    completionTokens: stats.completionTokens,
    reasoningTokens: stats.reasoningTokens,
    providerError: stats.providerError,
    loopRepeats: stats.loopRepeats,
    durationMs: Date.now() - started,
  };
}

const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// A moving reply, written into the build's log by how much it has produced.
function progressNote(trace: ProviderTrace | undefined, milestone: Milestone, started: number, attempt: number, continuation?: number) {
  const { stats } = milestone;
  const label = milestone.kind === "thinking"
    ? milestone.first ? "The model started thinking" : `Thinking: ${grouped(stats.reasoningChars)} characters so far`
    : milestone.first ? "The model started writing the page" : `Writing the page: ${grouped(stats.contentChars)} characters so far`;
  return trace?.note({ phase: "provider_progress", label, status: "calling", detail: { attempt, continuation, ...streamDetail(stats, started) } });
}

// A second go after a reply stopped before its page began is only started
// while there is room to finish one.
const STOP_RETRY_FLOOR_MS = 120000;

// One chat completion, read as it streams. A reply is given as long as it
// keeps moving: nothing here stops one for being slow. What stops a reply is
// the stream -- the connection dropping, the provider erroring part way, the
// model repeating itself -- and each of those is written into the build's log
// with where the reply had got to. A page that had begun is kept and carried on
// from where it stopped; a reply that stopped before its page began gets one
// fresh go. A provider that stumbles before it answers -- a refused connection,
// a rate limit, a 5xx -- is asked once more, and one whose output cap is lower
// than what was asked for says what its cap is, so the same request goes again
// inside it. A reply that is all thinking and no answer goes again too, inside
// a ceiling wide enough to answer in.
async function complete(
  route: Route,
  messages: ChatMessage[],
  maxTokens: number,
  deadline: number,
  trace?: ProviderTrace,
  // `keepPartial`: a build written a page at a time wants a page its clock
  // stopped part way back as far as it got, not a failure (callProviderPart).
  meta?: { continuation?: number; keepPartial?: boolean },
): Promise<{ content: string; truncated: boolean; outOfTime?: boolean; stats?: StreamStats }> {
  let limit = maxTokens;
  // The most this provider will take, once it has said so itself. Widening
  // after an all-thinking reply stops here: asking again above a cap the
  // provider has already refused would only spend the loop.
  let ceiling = Number.POSITIVE_INFINITY;
  let widened = false;
  let retriedStop = false;
  let nudge: string | null = null;
  const streaming = streamReplies();
  let host = route.baseUrl;
  try { host = new URL(route.baseUrl).host; } catch { /* keep the raw base if it is not a URL */ }
  for (let attempt = 0; attempt < MAX_COMPLETE_LOOPS; attempt += 1) {
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
        stream: streaming,
      },
    });
    // The one clock left is the platform's own: an action has ten minutes, and
    // the pictures and the save need the end of them. It never decides that a
    // reply has stalled. When it does run out, what the reply was doing then is
    // what gets recorded -- still writing, still thinking, or never started.
    const clock = new AbortController();
    let outOfTime = false;
    const timer = setTimeout(() => { outOfTime = true; clock.abort(); }, Math.max(1000, deadline - Date.now()));
    let response: Response | undefined;
    let bodyText = "";
    let streamed: { content: string; stats: StreamStats } | undefined;
    let stopped: StreamStopped | undefined;
    let unreachable: unknown;
    try {
      response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        signal: clock.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(requestBody(route, widened ? withNudge(messages, ANSWER_NOW) : nudge ? withNudge(messages, nudge) : messages, limit, streaming)),
      });
      if (response.ok && isEventStream(response)) {
        streamed = await readStream(response.body!, {
          started,
          cutShort: () => (outOfTime ? "out_of_time" : null),
          scrub: scrubKeys,
          onMilestone: (milestone) => progressNote(trace, milestone, started, attempt, meta?.continuation),
        });
      } else {
        bodyText = await response.text();
      }
    } catch (error) {
      if (error instanceof StreamStopped) stopped = error;
      else if (outOfTime) {
        stopped = new StreamStopped("out_of_time", { phase: "waiting", reasoningChars: 0, contentChars: 0, chunks: 0, keepAlives: 0, bytes: 0, sawDone: false }, "");
      } else if (response) {
        // The headers came and the body did not: the connection went while a
        // whole reply was on its way.
        stopped = new StreamStopped("dropped", {
          phase: "waiting", reasoningChars: 0, contentChars: 0, chunks: 0, keepAlives: 0, bytes: 0, sawDone: false,
          providerError: scrubKeys(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 160),
        }, "");
      } else unreachable = error;
    } finally {
      clearTimeout(timer);
    }
    if (unreachable !== undefined) {
      await trace?.note({
        phase: "provider_error",
        label: "The model provider could not be reached",
        level: "error",
        detail: {
          attempt, continuation: meta?.continuation, durationMs: Date.now() - started, host, model: route.model, errorClass: "unreachable",
          providerError: scrubKeys(unreachable instanceof Error ? `${unreachable.name}: ${unreachable.message}` : String(unreachable)).slice(0, 160),
        },
      });
      if (attempt === 0) { await wait(RETRY_WAIT_MS); continue; }
      throw new Error("The model provider could not be reached. Try again in a moment.");
    }
    if (stopped) {
      const { reason, stats } = stopped;
      // The step's clock ran out while the page was being written. Kept, this
      // is a checkpoint rather than a stop: the next step carries the page on
      // from this character, and says so in the build's log.
      if (reason === "out_of_time" && meta?.keepPartial && stats.phase === "writing" && stopped.content) {
        return { content: stopped.content, truncated: true, outOfTime: true, stats };
      }
      await trace?.note({
        phase: "provider_stop",
        label: stopLabel(reason, stats.phase),
        level: reason === "out_of_time" ? "error" : "warn",
        detail: { attempt, continuation: meta?.continuation, host, model: route.model, stopReason: reason, errorClass: STOP_CLASS[reason], ...streamDetail(stats, started) },
      });
      if (reason === "out_of_time") throw new ReplyStopped(stopped);
      // The page had begun: what it has is kept, and the next call carries on
      // from the character where this one stopped.
      const begun = stats.phase === "writing" && (meta?.continuation ? stopped.content.length > 0 : /```html|<!doctype html/i.test(stopped.content));
      if (begun) {
        await trace?.note({
          phase: "provider_resume",
          label: "Carrying on from where the page stopped",
          level: "warn",
          detail: { attempt, continuation: meta?.continuation, stopReason: reason, replyChars: stopped.content.length, host, model: route.model },
        });
        return { content: stopped.content, truncated: true, stats };
      }
      if (!retriedStop && deadline - Date.now() > STOP_RETRY_FLOOR_MS) {
        retriedStop = true;
        nudge = reason === "looping" ? GO_ROUND : null;
        await trace?.note({
          phase: "provider_retry",
          label: "Asking the model again",
          level: "warn",
          detail: { attempt, continuation: meta?.continuation, stopReason: reason, errorClass: STOP_CLASS[reason], host, model: route.model },
        });
        continue;
      }
      throw new ReplyStopped(stopped);
    }
    response = response!;
    if (!response.ok) {
      // A provider whose output cap is lower than what was asked for says so
      // in its own words. Some name the range, and that exact number is used
      // when it is there; anything else that refuses over the length just
      // gets one more go inside a cap every chat model clears, rather than
      // failing a build over a number.
      const named = response.status === 400 ? bodyText.match(/max_tokens[^[\]]*\[\s*\d+\s*,\s*(\d+)\s*\]/i) : null;
      const overLength =
        response.status === 400 && /max_?(?:output_?)?tokens/i.test(bodyText) && limit > SAFE_MAX_TOKENS;
      if ((named && Number(named[1]) > 0 && Number(named[1]) < limit) || overLength) {
        limit = named ? Number(named[1]) : SAFE_MAX_TOKENS;
        ceiling = limit;
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
    let content: unknown;
    let finishReason: string | undefined;
    let reasoningChars = 0;
    if (streamed) {
      content = streamed.content;
      finishReason = streamed.stats.finishReason;
      reasoningChars = streamed.stats.reasoningChars;
    } else {
      let data: {
        choices?: {
          finish_reason?: unknown;
          message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
        }[];
      };
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
      content = choice?.message?.content;
      finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      reasoningChars = reasoningOf(choice?.message).length;
    }
    const readDetail = streamed ? streamDetail(streamed.stats, started) : { stream: false, reasoningChars: reasoningChars || undefined, finishReason };
    if (typeof content !== "string" || !content.trim()) {
      // A reasoning model puts its thinking in its own field and counts it
      // against the same length budget, so a long enough think leaves nothing
      // to say and the page never starts. The same request would buy the same
      // answer a minute later, but this one does not go again as it was: the
      // ceiling rises to a length worth answering in -- never above a cap the
      // provider has already named -- and the model is told to keep the
      // planning short and write the reply. That is a different request, and
      // it is the one that finishes. One go at it, while there is time. After
      // that what has to change is the model or the deployment's limit, and
      // neither is something another attempt can reach.
      const spentThinking = reasoningChars > 0 || finishReason === "length";
      const room = Math.min(ceiling, Math.max(limit, ROOM_TO_ANSWER));
      if (spentThinking && !widened && deadline - Date.now() > ANSWER_FLOOR_MS) {
        widened = true;
        const grew = room > limit;
        limit = room;
        await trace?.note({
          phase: "provider_room",
          label: grew ? "Giving the model more room to answer" : "Asking the model again for an answer",
          level: "warn",
          detail: {
            ...readDetail,
            httpStatus: 200,
            attempt,
            durationMs: Date.now() - started,
            errorClass: "reasoning_budget",
            tokensAsked: limit,
            host,
            model: route.model,
          },
        });
        continue;
      }
      await trace?.note({
        phase: "provider_error",
        label: spentThinking
          ? "The model spent its length limit thinking and returned no page"
          : "The model returned an empty reply",
        level: "error",
        detail: {
          ...readDetail,
          httpStatus: 200,
          attempt,
          durationMs: Date.now() - started,
          errorClass: spentThinking ? "reasoning_budget" : "empty",
          tokensAsked: limit,
          host,
          model: route.model,
        },
      });
      throw new Error(
        spentThinking
          ? "The model returned only its reasoning and no page. This deployment's model or length limit needs changing."
          : "The model returned an empty reply",
      );
    }
    await trace?.note({
      phase: "provider_response",
      label: "The model answered",
      detail: {
        ...readDetail,
        httpStatus: 200,
        durationMs: Date.now() - started,
        attempt,
        continuation: meta?.continuation,
        truncated: finishReason === "length",
        replyChars: content.length,
        tokensAsked: limit,
        host,
        model: route.model,
      },
    });
    return { content, truncated: finishReason === "length", stats: streamed?.stats };
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
  purpose: Purpose = "chat",
) {
  return (await provide(messages, { tokenLimit, budgetMs, trace, purpose })).content;
}

// A reply for a build written a page at a time (buildDraft.ts): the same call
// on the build route, except that a reply the step's clock stops while it is
// writing comes back as far as it got, marked cut, instead of failing -- the
// next step carries it on from that character. `resuming` is a reply that is
// itself carrying a page on, so it starts mid-page rather than at a fence.
export async function callProviderPart(
  messages: ChatMessage[],
  budgetMs: number,
  trace?: ProviderTrace,
  resuming = false,
) {
  return await provide(messages, { budgetMs, trace, purpose: "build", keepPartial: true, resuming });
}

async function provide(
  messages: ChatMessage[],
  options: { tokenLimit?: number; budgetMs: number; trace?: ProviderTrace; purpose: Purpose; keepPartial?: boolean; resuming?: boolean },
): Promise<{ content: string; cut: boolean; outOfTime?: boolean; stats?: StreamStats }> {
  const { trace, purpose, keepPartial, resuming } = options;
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
  const maxTokens = options.tokenLimit ?? maxTokensFor(purpose);
  const deadline = Date.now() + Math.min(options.budgetMs, TEXT_BUDGET_MS);
  const carried = resuming ? 1 : 0;
  let reply = await complete(route, messages, maxTokens, deadline, trace, { continuation: carried || undefined, keepPartial });
  let content = reply.content;
  for (
    let round = 0;
    reply.truncated && !reply.outOfTime && round < MAX_CONTINUATIONS && (resuming || /```html|<!doctype html/i.test(content)) && deadline - Date.now() > CONTINUE_FLOOR_MS;
    round += 1
  ) {
    try {
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
        { continuation: carried + round + 1, keepPartial },
      );
    } catch (error) {
      // What the reply had written stays written: a build that keeps its
      // pages carries it on in its next step rather than losing it here.
      if (keepPartial) {
        const outOfTime = error instanceof ReplyStopped && error.stop.reason === "out_of_time";
        return { content, cut: true, outOfTime, stats: outOfTime ? error.stop.stats : reply.stats };
      }
      throw error;
    }
    // A continuation that opens its own fence anyway would split the page in two.
    content += reply.content.replace(/^\s*```(?:html)?[ \t]*\r?\n/i, "");
  }
  return { content, cut: reply.truncated, outOfTime: reply.outOfTime, stats: reply.stats };
}

// The page is the fenced block; the sentence before it is the summary. A
// reply that is nothing but a document still counts. A reply that never
// reaches for a page at all is an answer rather than a build, and comes back
// with `html: null` so the caller charges for a conversation instead.
// `clones` is the design agent's clones block: the Awwwards originals it says
// the header, the dropdown menu and the footer were cloned from.
export type ParsedReply = { html: string | null; shell?: string; pages?: SitePage[]; summary: string; clones?: string };

// What a reply built, or null when it answered instead of building.
export function builtSite(parsed: ParsedReply): BuiltSite | null {
  if (parsed.shell && parsed.pages?.length) return { shell: parsed.shell, pages: parsed.pages };
  return parsed.html ? { html: parsed.html } : null;
}

// Every fenced block in a reply: what followed its opening backticks, its
// text, and whether it was closed. The last block of a reply the token cap
// cut off has no closing fence, and that is the difference between a site
// and most of one. A crew builder's part is read the same way (crew.ts).
export function fencedBlocks(content: string) {
  const blocks: { info: string; body: string; closed: boolean; index: number }[] = [];
  const fence = /```[ \t]*([^\n]*)\n([\s\S]*?)(```|$)/g;
  for (let match = fence.exec(content); match; match = fence.exec(content)) {
    blocks.push({ info: match[1].trim(), body: match[2].trim(), closed: match[3] === "```", index: match.index });
    if (!match[3]) break;
  }
  return blocks;
}

function clonesIn(blocks: ReturnType<typeof fencedBlocks>) {
  return blocks.find((block) => /^clones\b/i.test(block.info))?.body.trim() || undefined;
}

export function fenceAttr(info: string, name: string) {
  return (
    info.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ??
    info.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1] ??
    null
  );
}

// A page's title when its fence did not carry one: its heading, else its
// address, else the home page. The tab needs something either way.
function titleFor(body: string, path: string) {
  const heading = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (heading) return heading.slice(0, 120);
  const last = path.split("/").filter(Boolean).pop();
  return last ? last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Home";
}

// The sentence before the first block, as the summary of what was built.
function summaryBefore(content: string, opened: number | undefined) {
  const before = opened === undefined ? "" : content.slice(0, opened).trim();
  return (before.split(/\n+/).find((line) => line.trim()) ?? "")
    .replace(/^[\s\-*#>\d.)]+/, "")
    .trim()
    .slice(0, REASON_LIMIT);
}

export function parseReply(content: string): ParsedReply {
  const blocks = fencedBlocks(content);
  const shellBlock = blocks.find((block) => /^html\s+shell\b/i.test(block.info));
  const pageBlocks = blocks.filter(
    (block) => /^html\b/i.test(block.info) && (fenceAttr(block.info, "path") !== null || /^html\s+\/\S*/i.test(block.info)),
  );
  if (shellBlock || pageBlocks.length) {
    // A site in blocks. Everything named has to be there and whole: a shell
    // or a page the token cap cut off is a broken build, not a smaller one.
    if (!shellBlock || !shellBlock.closed || !/<html[\s>]/i.test(shellBlock.body) || !/<\/html>\s*$/i.test(shellBlock.body)) {
      throw new Error("The model did not return a complete site: the shell is missing or unfinished");
    }
    const pages: SitePage[] = [];
    for (const block of pageBlocks) {
      if (!block.closed) throw new Error("The model did not return a complete site: a page was cut off");
      const path = normalizePath(fenceAttr(block.info, "path") ?? block.info.match(/^html\s+(\/\S*)/i)?.[1] ?? "/");
      if (path === null) throw new Error("The model did not return a complete site: a page has an address that cannot be served");
      // The first page at an address is the page; a repeat is the model saying
      // the same thing twice, not a second page.
      if (pages.some((page) => page.path === path)) continue;
      pages.push({ path, title: (fenceAttr(block.info, "title") ?? titleFor(block.body, path)).trim(), body: block.body });
    }
    if (!pages.some((page) => page.path === "/")) {
      throw new Error("The model did not return a complete site: there is no home page");
    }
    return { html: null, shell: shellBlock.body, pages, summary: summaryBefore(content, blocks[0].index), clones: clonesIn(blocks) };
  }
  // One document and no blocks: a reply in the form builds took before pages
  // existed, which the model may still give and which is still a whole site.
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
  // The sentence comes before every block, the clones block included.
  const opened = Math.min(fence?.index ?? unfenced?.index ?? Infinity, blocks[0]?.index ?? Infinity);
  return { html, summary: summaryBefore(content, Number.isFinite(opened) ? opened : undefined), clones: clonesIn(blocks) };
}

// A rework's reply. The design reviewer sends back the header, the menu and
// the footer, and those live in the shell, so the shell is what has to come
// back whole. A page that comes back with it replaces the page at its path; a
// page that does not, or that the length limit cut off, stays as it was.
export function parseShellReply(content: string): { shell: string; pages: SitePage[]; summary: string; clones?: string } {
  const blocks = fencedBlocks(content);
  const isPage = (info: string) => fenceAttr(info, "path") !== null || /^html\s+\/\S*/i.test(info);
  const shellBlock =
    blocks.find((block) => /^html\s+shell\b/i.test(block.info)) ??
    blocks.find((block) => /^html\b/i.test(block.info) && !isPage(block.info) && /<html[\s>]/i.test(block.body));
  if (!shellBlock || !shellBlock.closed || !/<html[\s>]/i.test(shellBlock.body) || !/<\/html>\s*$/i.test(shellBlock.body)) {
    throw new Error("The model did not return a complete site: the shell is missing or unfinished");
  }
  const pages: SitePage[] = [];
  for (const block of blocks) {
    if (block === shellBlock || !block.closed || !/^html\b/i.test(block.info) || !isPage(block.info)) continue;
    const path = normalizePath(fenceAttr(block.info, "path") ?? block.info.match(/^html\s+(\/\S*)/i)?.[1] ?? "/");
    if (path === null || pages.some((page) => page.path === path)) continue;
    pages.push({ path, title: (fenceAttr(block.info, "title") ?? titleFor(block.body, path)).trim(), body: block.body });
  }
  return { shell: shellBlock.body, pages, summary: summaryBefore(content, blocks[0]?.index), clones: clonesIn(blocks) };
}

// Where a reasoning model keeps its thinking. It is not an answer and never
// reaches a page, so it is read only to explain an empty reply; providers that
// speak the OpenAI shape do not agree on the name.
function reasoningOf(message: { reasoning_content?: unknown; reasoning?: unknown } | undefined) {
  for (const value of [message?.reasoning_content, message?.reasoning]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
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
  const scrubbed = [process.env.AI_API_KEY, process.env.AI_BUILD_API_KEY, process.env.AI_IMAGE_API_KEY].reduce<string>(
    (text, key) => (key ? text.split(key).join("[key]") : text),
    raw,
  );
  return scrubbed.slice(0, REASON_LIMIT) || "The build failed";
}
