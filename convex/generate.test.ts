/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseReply } from "./generate";
import { REQUEST_COSTS, planFor } from "./plans";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

async function createUser(
  t: ReturnType<typeof fresh>,
  fields: { isAnonymous?: boolean; email?: string },
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

// Building needs credits the free plan does not have, so members start on Starter.
async function createBuilder(t: ReturnType<typeof fresh>, email: string) {
  const member = await createUser(t, { email });
  await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
  return member;
}

const free = planFor("free");
const starter = planFor("starter");
const premium = planFor("premium");
// A member on Starter, holding the free welcome grant plus the month's allowance.
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits + starter.monthlyCredits!;
// What a free member holds: the welcome grant, which does not cover a build.
const FREE_OPENING = (free.monthlyCredits ?? 0) + free.signupCredits;
const KEY = "sk-test-secret-key";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const PAGE_TWO = PAGE.replace("Bakery on Main", "Bakery on Main — now with hours");

type Call = { url: string; headers: Record<string, string>; body: any };

function stubProvider(respond: (body: any, call: number) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      return respond(body, calls.length);
    }),
  );
  return calls;
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const reply = (summary: string, html = PAGE) =>
  json({ choices: [{ message: { content: `${summary}\n\n\`\`\`html\n${html}\n\`\`\`` } }] });

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
});

describe("parseReply", () => {
  test("takes the fenced page and the sentence before it", () => {
    const parsed = parseReply(`1. Built a warm bakery landing page.\n\n\`\`\`html\n${PAGE}\n\`\`\`\nAnything after is ignored.`);
    expect(parsed.html).toBe(PAGE);
    expect(parsed.summary).toBe("Built a warm bakery landing page.");
  });

  test("accepts a bare document and an unlabelled fence", () => {
    expect(parseReply(`  ${PAGE}  `)).toEqual({ html: PAGE, summary: "" });
    expect(parseReply(`\`\`\`\n${PAGE}\n\`\`\``).html).toBe(PAGE);
  });

  test("refuses anything that reaches for a page and does not finish it", () => {
    expect(() => parseReply("```html\n<div>half</div>\n```")).toThrow("complete page");
    // Cut off by the token cap: an opening fence with no closing one is a
    // broken build, not something to file away as conversation.
    expect(() => parseReply(`Built it.\n\n\`\`\`html\n${PAGE.slice(0, 80)}`)).toThrow("complete page");
    expect(() => parseReply(`<html lang="en"><body>cut off here`)).toThrow("complete page");
  });

  test("prose with no page is an answer, kept whole", () => {
    const talk = "Warm cream and a deep terracotta would suit a bakery.\n\nWant me to apply it?";
    expect(parseReply(talk)).toEqual({ html: null, summary: talk });
    // A fenced snippet that is not a page is still prose to the reader.
    expect(parseReply("Sure! Here is some CSS: body{margin:0}").html).toBe(null);
    // Naming a tag while talking shop is not an attempt to build.
    expect(parseReply("I would put a lang attribute on your <html> tag.").html).toBe(null);
  });
});

describe("attachments reach the model", () => {
  // The files a member attaches, as the composer would leave them.
  async function withFiles(
    t: ReturnType<typeof fresh>,
    conversationId: Id<"conversations">,
    files: { name: string; mimeType: string; body: string }[],
  ) {
    const ids: Id<"attachments">[] = [];
    for (const file of files) {
      const storageId = await t.run(
        async (ctx) => await ctx.storage.store(new Blob([file.body], { type: file.mimeType })),
      );
      ids.push(
        await t.run(
          async (ctx) =>
            await ctx.db.insert("attachments", {
              userId: (await ctx.db.get(conversationId))!.userId,
              conversationId,
              storageId,
              name: file.name,
              mimeType: file.mimeType,
              size: file.body.length,
              kind: file.mimeType.startsWith("image/") ? "image" : "text",
              text: file.mimeType.startsWith("image/") ? undefined : file.body,
              createdAt: Date.now(),
            }),
        ),
      );
    }
    return ids;
  }

  test("a photo goes to the model as a picture, and its URL is offered to the page", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const attachmentIds = await withFiles(t, conversationId, [
      { name: "storefront.png", mimeType: "image/png", body: "png-bytes" },
    ]);
    const calls = stubProvider(() => reply("Used your storefront photo in the hero."));

    await member.as.action(api.generate.run, {
      conversationId,
      prompt: "Use my storefront photo in the hero",
      attachmentIds,
    });

    const sent = calls[0].body.messages;
    const last = sent.at(-1);
    // The prompt carries the picture, which is what a vision endpoint reads.
    expect(last.role).toBe("user");
    expect(last.content[0]).toEqual({ type: "text", text: "Use my storefront photo in the hero" });
    expect(last.content[1].type).toBe("image_url");
    expect(last.content[1].image_url.url).toContain("/api/storage/");
    // And the same URL is offered for the page to load.
    const assets = sent.find(
      (message: any) => typeof message.content === "string" && message.content.includes("storefront.png"),
    );
    expect(assets.content).toContain(last.content[1].image_url.url);

    // The photo now belongs to the prompt it went with, so it leaves the tray.
    const listed = await member.as.query(api.attachments.list, { conversationId });
    expect(listed[0].messageId).toBeTruthy();
  });

  test("a text file is handed over as its contents", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const attachmentIds = await withFiles(t, conversationId, [
      { name: "brand.md", mimeType: "text/markdown", body: "# Brand\nWarm neutrals, no red." },
    ]);
    const calls = stubProvider(() => reply("Followed your brand notes."));

    await member.as.action(api.generate.run, {
      conversationId,
      prompt: "Follow my brand notes",
      attachmentIds,
    });

    const sent = calls[0].body.messages;
    const notes = sent.find(
      (message: any) => typeof message.content === "string" && message.content.includes("brand.md"),
    );
    expect(notes.content).toContain("Warm neutrals, no red.");
    // No pictures, so the prompt stays a plain string.
    expect(sent.at(-1).content).toBe("Follow my brand notes");
  });

  test("a file that could not be read is named rather than passed off as content", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const storageId = await t.run(
      async (ctx) => await ctx.storage.store(new Blob(["%PDF-scan"], { type: "application/pdf" })),
    );
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("attachments", {
          userId: (await ctx.db.get(conversationId))!.userId,
          conversationId,
          storageId,
          name: "scan.pdf",
          mimeType: "application/pdf",
          size: 9,
          kind: "text" as const,
          textError: "No text could be read from this file.",
          createdAt: Date.now(),
        }),
    );
    const calls = stubProvider(() => reply("Built it from what you told me."));

    await member.as.action(api.generate.run, {
      conversationId,
      prompt: "Use the menu in this PDF",
      attachmentIds: [id],
    });

    const sent = calls[0].body.messages;
    const note = sent.find(
      (message: any) => typeof message.content === "string" && message.content.includes("scan.pdf"),
    );
    expect(note.content).toContain("could not be read");
  });

  test("a later prompt keeps the picture's URL without paying to look again", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const attachmentIds = await withFiles(t, conversationId, [
      { name: "logo.png", mimeType: "image/png", body: "png-bytes" },
    ]);
    const calls = stubProvider(() => reply("Done."));

    await member.as.action(api.generate.run, { conversationId, prompt: "Use my logo", attachmentIds });
    // The same ids again: they have already gone, so they are not re-sent.
    await member.as.action(api.generate.run, { conversationId, prompt: "Make the header taller", attachmentIds });

    const second = calls[1].body.messages;
    expect(typeof second.at(-1).content).toBe("string");
    expect(
      second.some((message: any) => typeof message.content === "string" && message.content.includes("logo.png")),
    ).toBe(true);
  });

  test("another member's file cannot be attached to this prompt", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const stranger = await createBuilder(t, "other@example.com");
    const mine = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const theirs = await stranger.as.mutation(api.sites.create, { name: "Their site" });
    const [theirFile] = await withFiles(t, theirs.conversationId, [
      { name: "secret.md", mimeType: "text/markdown", body: "their private notes" },
    ]);
    const calls = stubProvider(() => reply("Built it."));

    await member.as.action(api.generate.run, {
      conversationId: mine.conversationId,
      prompt: "Build my bakery site",
      attachmentIds: [theirFile],
    });

    const sent = calls[0].body.messages;
    expect(JSON.stringify(sent)).not.toContain("their private notes");
    expect(JSON.stringify(sent)).not.toContain("secret.md");
    // And it stays theirs, unsent.
    const stillTheirs = await t.run(async (ctx) => await ctx.db.get(theirFile));
    expect(stillTheirs?.messageId).toBeUndefined();
  });
});

describe("generate.run", () => {
  test("a first prompt builds the site, charges the generate cost, and keeps the version", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const calls = stubProvider(() => reply("Built a warm landing page with a menu."));

    const { messageId } = await member.as.action(api.generate.run, {
      conversationId,
      prompt: "A warm site for a neighbourhood bakery",
    });

    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.body, m.status ?? null])).toEqual([
      ["user", "A warm site for a neighbourhood bakery", null],
      ["assistant", "Built a warm landing page with a menu.", null],
    ]);
    expect(messages[1]._id).toBe(messageId);
    const [site] = await member.as.query(api.sites.list, {});
    expect(site.currentVersionId).toBe(messages[1].versionId);
    const current = await member.as.query(api.sites.currentHtml, { siteId });
    expect(current).toMatchObject({ html: PAGE, summary: "Built a warm landing page with a menu.", published: false });

    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: OPENING - REQUEST_COSTS.generate,
      reserved: 0,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ kind: "spend", amount: -REQUEST_COSTS.generate, note: "Site build" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ai.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.model).toBe("forge-test");
    const roles = calls[0].body.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user"]);
    expect(calls[0].body.messages[0].content).toContain("self-contained HTML file");
    expect(calls[0].body.messages[1].content).toBe("A warm site for a neighbourhood bakery");
  });

  test("a second prompt is an edit: the current page goes along and the edit cost is charged", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId, siteId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider((_body, call) =>
      call === 1 ? reply("Built the first version.") : reply("Added opening hours.", PAGE_TWO),
    );
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    await member.as.action(api.generate.run, { conversationId, prompt: "Add opening hours" });

    const second = calls[1].body.messages;
    expect(second.map((m: any) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    expect(second[1].content).toContain(PAGE);
    expect(second[2].content).toBe("A bakery site");
    expect(second[3].content).toBe("Built the first version.");
    expect(second[4].content).toBe("Add opening hours");

    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE_TWO);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toHaveLength(2);
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      OPENING - REQUEST_COSTS.generate - REQUEST_COSTS.edit,
    );
  });

  test("what a pending reply says is decided by what the turn can afford", async () => {
    const t = fresh();
    const pendingBody = async (conversationId: string) => {
      const messages = await t.run((ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId as any))
          .collect(),
      );
      return messages.filter((m) => m.status === "pending").at(-1)?.body;
    };

    // A free member can only ever afford to talk, so nothing promises a build.
    const free_ = await createUser(t, { email: "f@example.com" });
    const freeThread = await free_.as.mutation(api.sites.create, { name: "Hello" });
    await t.mutation(internal.generate.begin, {
      userId: free_.userId,
      conversationId: freeThread.conversationId,
      prompt: "Hello",
    });
    expect(await pendingBody(freeThread.conversationId)).toBe("Thinking\u2026");

    // A member who can afford one is told a build is happening.
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    await t.mutation(internal.generate.begin, { userId: member.userId, conversationId, prompt: "A bakery" });
    expect(await pendingBody(conversationId)).toBe("Building your site\u2026");

    // And once there is a page, the next one edits it rather than building it.
    stubProvider(() => reply("Built it."));
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    await t.mutation(internal.generate.begin, { userId: member.userId, conversationId, prompt: "Add hours" });
    expect(await pendingBody(conversationId)).toBe("Updating your site\u2026");
  });

  test("a provider failure marks the reply failed, gives the hold back, and never leaks the key", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => new Response(`upstream said no to ${KEY}`, { status: 502 }));

    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("answered 502");
    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.status ?? null])).toEqual([["user", null], ["assistant", "failed"]]);
    expect(messages[1].body).toContain("answered 502");
    expect(messages[1].body).toContain("[key]");
    expect(messages[1].body).not.toContain(KEY);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: OPENING,
      reserved: 0,
      available: OPENING,
    });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => hold.status)).toEqual(["released"]);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });

  test("a reply without a page is an answer: it lands in the thread and costs the chat rate", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const answer = "Warm cream with a deep terracotta would suit a bakery. Want me to build it?";
    stubProvider(() => json({ choices: [{ message: { content: answer } }] }));

    await member.as.action(api.generate.run, { conversationId, prompt: "What colours suit a bakery?" });

    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.body, m.status ?? null])).toEqual([
      ["user", "What colours suit a bakery?", null],
      ["assistant", answer, null],
    ]);
    // Nothing was built, so there is no version to point at or preview.
    expect(messages[1].versionId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
    expect(await member.as.query(api.sites.currentHtml, { siteId })).toBe(null);

    // The build hold was taken and all but the chat rate handed back.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: OPENING - REQUEST_COSTS.chat,
      reserved: 0,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ kind: "spend", amount: -REQUEST_COSTS.chat, note: "Chat" });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => [hold.requestKind, hold.amount, hold.status])).toEqual([
      ["generate", REQUEST_COSTS.generate, "settled"],
    ]);
  });

  test("a question about a built site keeps the page and charges chat, not an edit", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider((_body, call) =>
      call === 1
        ? reply("Built the first version.")
        : json({ choices: [{ message: { content: "I would keep the hero and tighten the menu." } }] }),
    );
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    await member.as.action(api.generate.run, { conversationId, prompt: "Does the menu read well?" });

    // The build survives the question untouched.
    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toHaveLength(1);
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      OPENING - REQUEST_COSTS.generate - REQUEST_COSTS.chat,
    );
    // The hold was an edit; what it settled for was a conversation.
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => hold.requestKind)).toEqual(["generate", "edit"]);
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ amount: -REQUEST_COSTS.chat, note: "Chat" });
  });

  test("a page cut off mid-document fails and gives the whole hold back", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() =>
      json({ choices: [{ message: { content: `Built it.\n\n\`\`\`html\n${PAGE.slice(0, 120)}` } }] }),
    );
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("complete page");
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(OPENING);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });

  test("without provider settings the build is refused and nothing is charged", async () => {
    delete process.env.AI_API_KEY;
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider(() => reply("never"));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("isn't set up");
    expect(calls).toHaveLength(0);
    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages[1]).toMatchObject({ role: "assistant", status: "failed" });
    expect((await member.as.query(api.billing.summary, {}))!.available).toBe(OPENING);
  });

  test("guests, strangers, and empty prompts are refused before anything is written", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const stranger = await createBuilder(t, "s@example.com");
    const guest = await createUser(t, { isAnonymous: true });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => reply("never"));
    await expect(member.as.action(api.generate.run, { conversationId, prompt: "   " })).rejects.toThrow(
      "Describe what you want",
    );
    await expect(
      stranger.as.action(api.generate.run, { conversationId, prompt: "Mine now" }),
    ).rejects.toThrow("Conversation not found");
    const guestThread = await t.run((ctx) =>
      ctx.db.insert("conversations", { userId: guest.userId, title: "Guest", updatedAt: 1 }),
    );
    await expect(
      guest.as.action(api.generate.run, { conversationId: guestThread, prompt: "Build" }),
    ).rejects.toThrow("This thread has no site");
    expect(await member.as.query(api.messages.list, { conversationId })).toEqual([]);
  });

  test("a balance too thin to build can still talk, at the chat rate", async () => {
    const t = fresh();
    // A free member's welcome credits do not cover a build.
    const member = await createUser(t, { email: "m@example.com" });
    expect(FREE_OPENING).toBeLessThan(REQUEST_COSTS.generate);
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Hello" });
    const answer = "Happy to help. What is the site for?";
    const calls = stubProvider(() => json({ choices: [{ message: { content: answer } }] }));

    await member.as.action(api.generate.run, { conversationId, prompt: "Hello" });

    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.body, m.status ?? null])).toEqual([
      ["user", "Hello", null],
      ["assistant", answer, null],
    ]);
    // The model is told it may not build, and what standing in the way costs.
    const system = calls[0].body.messages.filter((m: any) => m.role === "system");
    expect(system[1].content).toContain("This turn is TALK");
    expect(system[1].content).toContain(`${REQUEST_COSTS.generate} credits and they have ${FREE_OPENING}`);
    // Held and settled as a chat, so the welcome credits are not eaten by one hello.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: FREE_OPENING - REQUEST_COSTS.chat,
      reserved: 0,
    });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => [hold.requestKind, hold.amount, hold.status])).toEqual([
      ["chat", REQUEST_COSTS.chat, "settled"],
    ]);
    expect(await member.as.query(api.sites.currentHtml, { siteId })).toBe(null);
  });

  test("a free member can keep talking, a credit at a time, and is remembered between turns", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Hello" });
    const calls = stubProvider((_body, call) =>
      json({ choices: [{ message: { content: `Answer ${call}.` } }] }),
    );

    for (const prompt of ["Hello", "What would a bakery site need?", "How much would that cost?"]) {
      await member.as.action(api.generate.run, { conversationId, prompt });
    }

    // Three turns, three credits, and nothing still held.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: FREE_OPENING - 3 * REQUEST_COSTS.chat,
      reserved: 0,
    });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => [hold.requestKind, hold.status])).toEqual([
      ["chat", "settled"],
      ["chat", "settled"],
      ["chat", "settled"],
    ]);
    // Earlier turns come along, so the conversation has a memory.
    const third = calls[2].body.messages;
    expect(third.filter((m: any) => m.role !== "system").map((m: any) => m.content)).toEqual([
      "Hello",
      "Answer 1.",
      "What would a bakery site need?",
      "Answer 2.",
      "How much would that cost?",
    ]);
    // Talking is not building.
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });

  test("a talk-only turn hands over no page, even if the model builds one anyway", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => reply("Built your bakery site."));

    await member.as.action(api.generate.run, { conversationId, prompt: "Build me a bakery site" });

    // A build held at the chat rate would be a build for one credit.
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
    expect(await member.as.query(api.sites.currentHtml, { siteId })).toBe(null);
    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages[1].body).toBe(
      `Building this costs ${REQUEST_COSTS.generate} credits and you have ${FREE_OPENING}. ` +
        "Top up or upgrade and I'll build it \u2014 until then I can help you plan it here.",
    );
    expect(messages[1].versionId).toBeUndefined();
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      FREE_OPENING - REQUEST_COSTS.chat,
    );
  });

  test("a balance too thin even to talk is refused before the prompt is recorded", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    // The row is written the first time credits are touched; spend it dry.
    await t.mutation(internal.billing.ensure, { userId: member.userId });
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", member.userId))
        .unique();
      await ctx.db.patch(sub!._id, { credits: 0 });
    });
    const calls = stubProvider(() => reply("never"));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow(`Out of credits: this needs ${REQUEST_COSTS.chat} and you have 0`);
    expect(calls).toHaveLength(0);
    expect(await member.as.query(api.messages.list, { conversationId })).toEqual([]);
  });

  test("the top plan builds against its allowance, not without one", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => reply("Built it."));
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    const summary = (await member.as.query(api.billing.summary, {}))!;
    expect(summary).toMatchObject({
      unlimited: false,
      reserved: 0,
      credits: FREE_OPENING + premium.monthlyCredits! - REQUEST_COSTS.generate,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ kind: "spend", amount: -REQUEST_COSTS.generate });
  });
});
