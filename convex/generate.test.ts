/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
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
// A member on Starter, holding the free welcome grant plus the month's allowance.
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits + starter.monthlyCredits!;
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

  test("running out of credits refuses before the prompt is recorded", async () => {
    const t = fresh();
    // A free member's welcome credits do not cover a build.
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider(() => reply("never"));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("Out of credits: this needs 40 and you have 30. Upgrade to start building.");
    expect(calls).toHaveLength(0);
    expect(await member.as.query(api.messages.list, { conversationId })).toEqual([]);
  });

  test("an unlimited plan builds without a balance", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "premium" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => reply("Built it."));
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    const summary = (await member.as.query(api.billing.summary, {}))!;
    expect(summary).toMatchObject({ unlimited: true, reserved: 0 });
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ kind: "spend", amount: -REQUEST_COSTS.generate });
  });
});
