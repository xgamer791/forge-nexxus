import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "./_generated/server";
import { TEXT_LIMIT, TEXT_TOTAL_LIMIT, VISION_LIMIT } from "./attachments";
import { creditCheck, holdCredits, releaseHold, settleHold } from "./billing";
import { REQUEST_COSTS, requestKind, type RequestKind } from "./plans";

// How much of the thread the model sees, and how long a page it may write.
const HISTORY_LIMIT = 12;
const DEFAULT_MAX_TOKENS = 10000;
const REASON_LIMIT = 300;
// A conversational reply is the message itself, so it gets far more room than
// the one-line summary that rides along with a build.
const TALK_LIMIT = 4000;

const SYSTEM_PROMPT = `You are Forge, a senior web designer and front-end developer. You build complete, beautiful, responsive websites for people who describe what they want in plain language.

You give one of two kinds of reply, and what the user asked for decides which.

BUILD — when they describe a site to make, or ask for a change to the page.
Return one self-contained HTML file:
- A full document (<!doctype html> … </html>) with a <title>, a meta viewport, and all CSS in one <style> block in the <head>.
- Mobile-first and responsive; generous whitespace; a deliberate colour palette and type scale; accessible contrast; semantic landmarks (header, nav, main, section, footer).
- Real, specific copy written for this site — never lorem ipsum or "[placeholder]".
- No scripts and no frameworks. The only pictures you may load are the user's own attached assets, whose exact URLs are listed for you when they have attached any; use them where they belong, with alt text. Otherwise use CSS gradients, inline SVG and colour blocks, and give every visual a purpose.
- Google Fonts are the only allowed external resource; use at most two families.
- Links between sections use anchors; forms are static markup.
Reply with one sentence saying what you built or changed, then the complete HTML in a single \`\`\`html code block, and nothing after it. When the user asks for a change, apply it to the current file and return the whole updated file, keeping everything they did not ask to change.

TALK — when they ask a question, want an opinion, or are still working out what they want.
Reply in plain prose: short, concrete, and about their site. Do not return HTML, and do not open a code block of any kind. Say what you would do and offer to make the change, rather than making it. A build costs the user credits and a reply like this barely does, so do not rebuild the page to answer a question.

If both readings are open, talk and ask which they meant.`;

// What the thread shows while the request runs. The server picks it, because
// the server is what knows whether this turn can build: promising to build a
// site to someone whose balance only covers a conversation is a lie the client
// cannot help telling on its own.
const PENDING_LABELS: Record<RequestKind, string> = {
  chat: "Thinking\u2026",
  generate: "Building your site\u2026",
  edit: "Updating your site\u2026",
  image: "Making an image\u2026",
  video: "Making a video\u2026",
};

// The provider takes either a plain string or the parts of a multimodal
// message. Attached pictures ride along as `image_url` parts, which is how
// every OpenAI-compatible vision endpoint takes them.
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

// What the user attached, as the model gets it: pictures to look at, files to
// read, and the URLs of every asset in the thread so a build can use them.
type Assets = {
  look: { name: string; url: string }[];
  read: { name: string; text: string }[];
  urls: { name: string; url: string }[];
  unread: string[];
};

// One prompt in, one build out. The credits are held before the provider is
// called and settled or released after, so a failed build costs nothing and a
// burst of prompts cannot outrun the balance.
export const run = action({
  args: {
    conversationId: v.id("conversations"),
    prompt: v.string(),
    // What the composer had attached when the prompt was sent.
    attachmentIds: v.optional(v.array(v.id("attachments"))),
  },
  handler: async (
    ctx,
    { conversationId, prompt, attachmentIds },
  ): Promise<{ messageId: Id<"messages"> }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const text = prompt.trim();
    if (!text) throw new ConvexError("Describe what you want first");
    const job = await ctx.runMutation(internal.generate.begin, {
      userId,
      conversationId,
      prompt: text,
      attachmentIds,
    });
    try {
      const reply = await callProvider(job.messages);
      const parsed = parseReply(reply);
      await ctx.runMutation(internal.generate.finish, {
        assistantId: job.assistantId,
        siteId: job.siteId,
        holdId: job.holdId,
        requestKind: job.requestKind,
        html: parsed.html ?? undefined,
        summary: parsed.summary,
        blockedNote: job.blockedNote,
      });
    } catch (error) {
      const reason = describe(error);
      await ctx.runMutation(internal.generate.fail, { assistantId: job.assistantId, holdId: job.holdId, reason });
      throw new ConvexError(reason);
    }
    return { messageId: job.assistantId };
  },
});

// Records the prompt, holds the credits, and hands the action everything the
// model needs, all in one transaction.
export const begin = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    prompt: v.string(),
    attachmentIds: v.optional(v.array(v.id("attachments"))),
  },
  handler: async (ctx, { userId, conversationId, prompt, attachmentIds }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || conversation.userId !== userId) throw new ConvexError("Conversation not found");
    const site = await ctx.db
      .query("sites")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .first();
    if (!site) throw new ConvexError("This thread has no site");
    const current = site.currentVersionId ? await ctx.db.get(site.currentVersionId) : null;
    const now = Date.now();
    const buildKind: RequestKind = current ? "edit" : "generate";
    // A balance too thin for a build can still afford to talk. Rather than
    // refuse the message outright, the turn becomes talk-only: the model is
    // told it may not build, and the hold is taken at the chat rate. Someone
    // out of credits can still ask what Forge would do and what it costs.
    const check = await creditCheck(ctx, userId, buildKind, now);
    const kind: RequestKind = check.affordable ? buildKind : "chat";
    const talkOnly = check.affordable
      ? null
      : { needed: check.needed, available: check.available ?? 0 };
    const { holdId } = await holdCredits(ctx, userId, kind, now);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(HISTORY_LIMIT);
    const userMessageId = await ctx.db.insert("messages", {
      conversationId,
      role: "user",
      body: prompt,
    });
    // The files the composer sent belong to this turn from now on, so a second
    // prompt does not pay to look at them again.
    const assets = await collectAssets(ctx, conversationId, attachmentIds ?? [], userMessageId);
    const assistantId = await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      body: PENDING_LABELS[kind],
      status: "pending",
    });
    await ctx.db.patch(conversationId, { updatedAt: now });
    await ctx.db.patch(site._id, { updatedAt: now });
    return {
      siteId: site._id,
      holdId,
      assistantId,
      requestKind: kind,
      // What the thread says if the model builds anyway on a talk-only turn.
      blockedNote: talkOnly
        ? `Building this costs ${talkOnly.needed} credits and you have ${talkOnly.available}. ` +
          "Top up or upgrade and I'll build it — until then I can help you plan it here."
        : undefined,
      messages: buildMessages(site.name, current?.html ?? null, recent.reverse(), prompt, talkOnly, assets),
    };
  },
});

// Turns the attachments the composer sent into what the model is given, and
// marks them as belonging to this prompt. Every image in the thread is listed
// by URL so an edit can keep using a logo uploaded ten turns ago, but only
// this turn's pictures are sent to be looked at again.
async function collectAssets(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  ids: Id<"attachments">[],
  messageId: Id<"messages">,
): Promise<Assets> {
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .order("asc")
    .collect();
  const chosen = new Set(ids.map(String));
  const sending = rows.filter((row) => chosen.has(String(row._id)) && row.messageId === undefined);
  for (const row of sending) await ctx.db.patch(row._id, { messageId });

  const assets: Assets = { look: [], read: [], urls: [], unread: [] };
  let budget = TEXT_TOTAL_LIMIT;
  for (const row of rows) {
    if (row.kind !== "image") continue;
    const url = await ctx.storage.getUrl(row.storageId);
    if (url) assets.urls.push({ name: row.name, url });
  }
  for (const row of sending) {
    if (row.kind === "image") {
      if (assets.look.length >= VISION_LIMIT) continue;
      const url = await ctx.storage.getUrl(row.storageId);
      if (url) assets.look.push({ name: row.name, url });
      continue;
    }
    const text = row.text?.slice(0, Math.max(0, Math.min(TEXT_LIMIT, budget))) ?? "";
    if (text) {
      assets.read.push({ name: row.name, text });
      budget -= text.length;
    } else {
      assets.unread.push(row.name);
    }
  }
  return assets;
}

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
  },
  handler: async (ctx, { assistantId, siteId, holdId, requestKind: kind, html, summary, blockedNote }) => {
    const now = Date.now();
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
      return;
    }
    const site = await ctx.db.get(siteId);
    // The site was deleted while the build ran: nothing to attach it to, and
    // the user is not charged for a page they can never see.
    if (!site) {
      await releaseHold(ctx, holdId, now);
      return;
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
    if (await ctx.db.get(assistantId)) {
      await ctx.db.patch(assistantId, {
        body: summary || (kind === "generate" ? "Here's a first version of your site." : "Updated your site."),
        status: undefined,
        versionId,
      });
    }
    await settleHold(ctx, holdId, undefined, now);
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
  assets: Assets = { look: [], read: [], urls: [], unread: [] },
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
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
  if (assets.urls.length > 0) {
    messages.push({
      role: "system",
      content:
        "These pictures belong to the user and are already hosted. Use the URLs exactly as written, " +
        "in <img> tags with alt text, wherever they belong in the page:\n" +
        assets.urls.map((asset) => `- ${asset.name}: ${asset.url}`).join("\n"),
    });
  }
  for (const file of assets.read) {
    messages.push({
      role: "system",
      content: `The user attached "${file.name}". Its contents:\n\n${file.text}`,
    });
  }
  if (assets.unread.length > 0) {
    messages.push({
      role: "system",
      content:
        `The user attached ${assets.unread.map((name) => `"${name}"`).join(", ")}, which could not be read. ` +
        "Say so plainly if it matters to what they asked, and work from what they told you.",
    });
  }
  for (const message of history) {
    if (message.role === "system" || message.status || !message.body.trim()) continue;
    messages.push({ role: message.role, content: message.body });
  }
  // The pictures ride on the prompt itself, which is what a vision endpoint
  // expects; a turn with none keeps the plain string a text model wants.
  messages.push({
    role: "user",
    content:
      assets.look.length > 0
        ? [
            { type: "text", text: prompt } as ContentPart,
            ...assets.look.map(
              (asset) => ({ type: "image_url", image_url: { url: asset.url } }) as ContentPart,
            ),
          ]
        : prompt,
  });
  return messages;
}

// Any OpenAI-compatible chat completions endpoint: the deployment names the
// base URL, the key and the model, and nothing about them reaches a client.
async function callProvider(messages: ChatMessage[]) {
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new ConvexError("Site generation isn't set up on this deployment yet");
  }
  const maxTokens = Number(process.env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`The model provider answered ${response.status}${excerpt(bodyText)}`);
  }
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error("The model provider sent an unreadable reply");
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned an empty reply");
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
  const html = fence
    ? fence[1].trim()
    : /^\s*(<!doctype html|<html)/i.test(content)
      ? content.trim()
      : null;
  if (!html || !/<html[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) {
    throw new Error("The model did not return a complete page");
  }
  const before = fence ? content.slice(0, fence.index).trim() : "";
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

// What the user is told. Never the key, never more than a line.
function describe(error: unknown) {
  const raw =
    error instanceof ConvexError
      ? String(error.data)
      : error instanceof Error
        ? error.message
        : String(error);
  const key = process.env.AI_API_KEY;
  const scrubbed = key ? raw.split(key).join("[key]") : raw;
  return scrubbed.slice(0, REASON_LIMIT) || "The build failed";
}
